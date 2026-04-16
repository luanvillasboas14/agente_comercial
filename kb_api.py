"""
Cockpit IA - Backend API
FastAPI + PostgreSQL + OpenAI
"""
import os
import re
import io
import csv
import time
import json
import hashlib
import secrets
import threading
import psycopg2
import psycopg2.extras
import requests as http_requests
from contextlib import contextmanager, asynccontextmanager
from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Depends, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel
from typing import Optional, List
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

MEDIA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'media')
os.makedirs(MEDIA_DIR, exist_ok=True)

ALLOWED_MEDIA_TYPES = {
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/quicktime', 'video/webm',
    'application/pdf',
}
MAX_UPLOAD_SIZE = 16 * 1024 * 1024


def _run_migrations_background():
    """Roda migrations + indexes em background para não bloquear o startup."""
    try:
        print("[API/BG] Iniciando migrations...", flush=True)
        run_migrations()
        print("[API/BG] Migrations OK", flush=True)
    except Exception as e:
        print(f"[API/BG] ERRO nas migrations: {e}", flush=True)

    try:
        print("[API/BG] Criando indexes...", flush=True)
        _create_indexes()
        print("[API/BG] Indexes OK", flush=True)
    except Exception as e:
        print(f"[API/BG] ERRO nos indexes: {e}", flush=True)


def _create_indexes():
    """Cria indexes com autocommit (necessário para não travar em transação)."""
    conn = psycopg2.connect(**DB_CONFIG)
    conn.set_session(autocommit=True)
    cur = conn.cursor()
    cur.execute("SET statement_timeout = 0")

    indexes = [
        ("idx_kb_tema", "knowledge_base", "tema"),
        ("idx_kb_conversation_id", "knowledge_base", "conversation_id"),
        ("idx_il_acao", "ia_interaction_log", "acao"),
        ("idx_il_confianca", "ia_interaction_log", "confianca"),
        ("idx_il_created_at", "ia_interaction_log", "created_at"),
        ("idx_il_conversation_id", "ia_interaction_log", "conversation_id"),
        ("idx_ce_avaliacao", "chat_evaluations", "avaliacao"),
        ("idx_ce_created_at", "chat_evaluations", "created_at"),
        ("idx_ce_prompt_version", "chat_evaluations", "prompt_version_id"),
    ]
    for idx_name, table, cols in indexes:
        try:
            cur.execute(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table} ({cols})")
            print(f"[API/BG]   Index {idx_name} OK", flush=True)
        except Exception as e:
            print(f"[API/BG]   Index {idx_name} FALHOU: {e}", flush=True)
            conn.rollback()

    cur.close()
    conn.close()


@asynccontextmanager
async def lifespan(app):
    skip = os.environ.get('SKIP_MIGRATIONS', 'false').lower() == 'true'
    if skip:
        print("[API] Migrations puladas (SKIP_MIGRATIONS=true)", flush=True)
    else:
        t = threading.Thread(target=_run_migrations_background, daemon=True)
        t.start()
        print("[API] Migrations iniciadas em background", flush=True)
    print("[API] Startup completo", flush=True)
    yield

app = FastAPI(title="Cockpit IA - Cruzeiro do Sul", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")
security = HTTPBasic(auto_error=False)

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY', '')
DB_CONFIG = {
    'host': os.environ.get('DB_HOST', 'localhost'),
    'port': int(os.environ.get('DB_PORT', 5432)),
    'user': os.environ.get('DB_USER', 'postgres'),
    'password': os.environ.get('DB_PASSWORD', ''),
    'dbname': os.environ.get('DB_NAME', 'log_conversa'),
    'connect_timeout': 10,
}
print(f"[API] DB_CONFIG: host={DB_CONFIG['host']}, port={DB_CONFIG['port']}, user={DB_CONFIG['user']}, dbname={DB_CONFIG['dbname']}", flush=True)
ADMIN_USER = os.environ.get('ADMIN_USER', 'admin')
ADMIN_PASS = os.environ.get('ADMIN_PASS', '')
AUTH_ENABLED = os.environ.get('AUTH_ENABLED', 'false').lower() == 'true'

DCZ_MSG = 'https://messaging.g1.datacrazy.io/api'
DCZ_TOKEN = os.environ.get('DCZ_TOKEN', '')

TEMAS = [
    'ACESSO_PORTAL', 'ACESSO_APP', 'MATRICULA', 'FINANCEIRO_MENSALIDADE',
    'FINANCEIRO_BOLETO', 'FINANCEIRO_REEMBOLSO', 'ACADEMICO_NOTAS',
    'ACADEMICO_DISCIPLINAS', 'ACADEMICO_ESTAGIO', 'ACADEMICO_TCC',
    'CERTIFICADO_DIPLOMA', 'AULAS_PRESENCIAIS', 'CANCELAMENTO',
    'TRANSFERENCIA', 'COMERCIAL', 'OUTRO'
]

MODEL_PRICING = {
    'gpt-4o':       {'input': 2.50, 'output': 10.00},
    'gpt-4o-mini':  {'input': 0.15, 'output': 0.60},
    'gpt-3.5-turbo':{'input': 0.50, 'output': 1.50},
}

DEFAULT_PROMPT = """Você é a assistente virtual de suporte da Cruzeiro do Sul Educacional.
Seu nome é "Assistente Virtual Cruzeiro do Sul". Você NÃO é um atendente humano.

{student_context}

{memory_context}

{sentiment_context}

## REGRAS ABSOLUTAS:
1. **NUNCA INVENTE** URLs, valores, prazos ou procedimentos que NÃO apareçam nas referências abaixo.
2. **NUNCA forneça dados pessoais** (RGM, e-mail acadêmico, senhas). Só um atendente humano pode fazer isso.
3. Informações CONSISTENTES em MÚLTIPLAS referências são confiáveis.
4. **NUNCA use nomes de atendentes** das referências (ex: Joyce, Camila). Você é a assistente virtual.
5. Se conhecer o nome do aluno, **USE-O** para personalizar.
6. **Quando o aluno responder a uma opção/botão**, interprete NO CONTEXTO do histórico.

## EMPATIA:
- Se o aluno parece frustrado, **valide o sentimento** antes de responder.
- Se é retorno, seja eficiente e direto.
- Se já tentou resolver, priorize escalação.

## 3 NÍVEIS DE CONFIANÇA:
### ALTO (0.8-1.0) → Responda normalmente
### MÉDIO (0.5-0.7) → Responda E ofereça atendente
### BAIXO (0.0-0.4) → Escale para humano

## COMO RESPONDER:
- Dê uma resposta COMPLETA e ÚTIL: inclua o passo a passo ou orientação prática que o aluno precisa para resolver.
- Não seja vago. Se as referências têm detalhes (links, caminhos no portal, prazos), INCLUA.
- Separe em blocos curtos (2-3 frases por bloco) usando quebras de linha para facilitar leitura.
- Use *negrito* para termos-chave (formatação WhatsApp). Máximo 1 emoji por bloco.
- Mantenha entre 3 e 6 frases no total. Nem telegráfico, nem textão.
- Última linha OBRIGATÓRIA (oculta para o aluno): [CONFIANCA:X.X]

## CONVERSAS DE REFERÊNCIA:
{references}

## HISTÓRICO DESTA CONVERSA:
{history}"""


# --- DB helpers ---

@contextmanager
def get_db():
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        conn.cursor().execute("SET statement_timeout = 0")
    except Exception as e:
        print(f"[API] ERRO ao conectar DB: {e}", flush=True)
        raise
    try:
        yield conn
    finally:
        conn.close()


def _seed_default_menus(cur):
    """Popula agent_menus com a árvore padrão de menus."""
    def ins(parent_id, level, key, label, text=None, rag=None, order=0):
        cur.execute(
            "INSERT INTO agent_menus (parent_id, level, menu_key, label, response_text, rag_question, sort_order) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id",
            (parent_id, level, key, label, text, rag, order))
        return cur.fetchone()[0]

    # L1 categories
    l1_acesso = ins(None, 'L1', 'acesso', 'Acesso Portal/App', 'Sobre *Acesso*, qual sua dúvida?', None, 0)
    l1_fin = ins(None, 'L1', 'financeiro', 'Financeiro', 'Sobre *Financeiro*, qual sua dúvida?', None, 1)
    l1_acad = ins(None, 'L1', 'academico', 'Aulas e Conteúdo', 'Sobre *Aulas e Conteúdo*, qual sua dúvida?', None, 2)
    l1_doc = ins(None, 'L1', 'documentos', 'Documentos', 'Sobre *Documentos*, o que precisa?', None, 3)
    l1_remat = ins(None, 'L1', 'rematricula', 'Rematrícula', 'Sobre *Rematrícula*, qual sua dúvida?', None, 4)

    # Acesso -> L2
    l2_primeiro = ins(l1_acesso, 'L2', 'primeiro acesso', 'Primeiro acesso', 'Sobre *Primeiro Acesso*:', None, 0)
    ins(l1_acesso, 'leaf', 'esqueci minha senha', 'Esqueci minha senha', None, 'esqueci minha senha do portal como redefinir', 1)
    ins(l1_acesso, 'leaf', 'app duda', 'App Duda', None, 'como baixar e acessar o app Duda', 2)
    ins(l1_acesso, 'leaf', 'blackboard / ava', 'Blackboard / AVA', None, 'como acessar o Blackboard ou ambiente virtual de aprendizagem', 3)
    # Primeiro acesso -> leaf
    ins(l2_primeiro, 'leaf', 'não recebi credenciais', 'Não recebi credenciais', None, 'não recebi meus dados de acesso credenciais do portal', 0)
    ins(l2_primeiro, 'leaf', 'onde me cadastro', 'Onde me cadastro', None, 'onde faço cadastro para acessar o portal do aluno', 1)
    ins(l2_primeiro, 'leaf', 'email acadêmico', 'Email acadêmico', None, 'qual meu email acadêmico e como acessar', 2)

    # Financeiro -> L2
    l2_boleto = ins(l1_fin, 'L2', 'boleto / pagamento', 'Boleto / Pagamento', 'Sobre *Boleto / Pagamento*:', None, 0)
    l2_mensal = ins(l1_fin, 'L2', 'mensalidade / valores', 'Mensalidade / Valores', 'Sobre *Mensalidade / Valores*:', None, 1)
    l2_negoc = ins(l1_fin, 'L2', 'negociar / parcelar', 'Negociar / Parcelar', 'Sobre *Negociação*:', None, 2)
    ins(l1_fin, 'leaf', 'reembolso', 'Reembolso', None, 'como solicitar reembolso de pagamento', 3)
    # Boleto -> leaf
    ins(l2_boleto, 'leaf', 'segunda via do boleto', 'Segunda via do boleto', None, 'como gerar segunda via do boleto de pagamento', 0)
    ins(l2_boleto, 'leaf', 'pagar com pix', 'Pagar com PIX', None, 'como pagar a mensalidade com PIX', 1)
    ins(l2_boleto, 'leaf', 'boleto vencido', 'Boleto vencido', None, 'meu boleto venceu o que fazer como pagar boleto vencido', 2)
    # Mensalidade -> leaf
    ins(l2_mensal, 'leaf', 'valor da mensalidade', 'Valor da mensalidade', None, 'qual o valor da mensalidade e como consultar valores', 0)
    ins(l2_mensal, 'leaf', 'desconto / bolsa', 'Desconto / Bolsa', None, 'como conseguir desconto ou bolsa na mensalidade', 1)
    ins(l2_mensal, 'leaf', 'reajuste de mensalidade', 'Reajuste de mensalidade', None, 'por que a mensalidade teve reajuste e como contestar', 2)
    # Negociar -> leaf
    ins(l2_negoc, 'leaf', 'parcelar dívida', 'Parcelar dívida', None, 'como parcelar mensalidades em atraso', 0)
    ins(l2_negoc, 'leaf', 'fazer acordo', 'Fazer acordo', None, 'como fazer acordo de pagamento de dívida', 1)
    ins(l2_negoc, 'leaf', 'estou inadimplente', 'Estou inadimplente', None, 'estou inadimplente o que acontece como regularizar', 2)

    # Acadêmico -> L2/leaf
    ins(l1_acad, 'leaf', 'início das aulas', 'Início das aulas', None, 'quando começam as aulas do semestre', 0)
    ins(l1_acad, 'leaf', 'disciplinas / grade', 'Disciplinas / Grade', None, 'como ver minhas disciplinas e grade curricular', 1)
    l2_provas = ins(l1_acad, 'L2', 'provas / atividades', 'Provas / Atividades', 'Sobre *Provas e Atividades*:', None, 2)
    ins(l1_acad, 'leaf', 'material didático', 'Material didático', None, 'como acessar o material didático das aulas', 3)
    # Provas -> leaf
    ins(l2_provas, 'leaf', 'datas das provas', 'Datas das provas', None, 'quando são as datas das provas do semestre', 0)
    ins(l2_provas, 'leaf', 'prazo de atividades', 'Prazo de atividades', None, 'qual o prazo para entrega de atividades', 1)
    ins(l2_provas, 'leaf', 'ver minhas notas', 'Ver minhas notas', None, 'como ver minhas notas e conceitos', 2)

    # Documentos -> leaf
    ins(l1_doc, 'leaf', 'declaração de matrícula', 'Declaração de matrícula', None, 'como emitir declaração de matrícula ou vínculo', 0)
    ins(l1_doc, 'leaf', 'histórico escolar', 'Histórico escolar', None, 'como solicitar histórico escolar', 1)
    ins(l1_doc, 'leaf', 'enviar documentos', 'Enviar documentos', None, 'como enviar documentos para a secretaria', 2)

    # Rematrícula -> leaf
    ins(l1_remat, 'leaf', 'como rematricular', 'Como rematricular', None, 'como fazer a rematrícula para o próximo semestre', 0)
    ins(l1_remat, 'leaf', 'prazo de rematrícula', 'Prazo de rematrícula', None, 'qual o prazo para rematrícula do semestre', 1)


def run_migrations():
    conn = psycopg2.connect(**DB_CONFIG)
    conn.set_session(autocommit=True)
    cur = conn.cursor()
    cur.execute("SET statement_timeout = 0")

    ddl_statements = [
        ("prompt_versions", """CREATE TABLE IF NOT EXISTS prompt_versions (
            id SERIAL PRIMARY KEY, name TEXT NOT NULL, system_prompt TEXT NOT NULL,
            is_active BOOLEAN DEFAULT FALSE, model TEXT DEFAULT 'gpt-4o-mini',
            temperature FLOAT DEFAULT 0.2, max_tokens INT DEFAULT 400,
            notes TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW())"""),
        ("chat_evaluations", """CREATE TABLE IF NOT EXISTS chat_evaluations (
            id SERIAL PRIMARY KEY, pergunta TEXT NOT NULL, resposta_ia TEXT,
            confianca FLOAT, avaliacao TEXT NOT NULL, resposta_corrigida TEXT,
            prompt_version_id INT, model TEXT, latency_ms INT, tokens_used INT,
            created_at TIMESTAMP DEFAULT NOW())"""),
        ("kb_whatsapp_buttons", """DO $$ BEGIN
            ALTER TABLE knowledge_base ADD COLUMN whatsapp_buttons TEXT DEFAULT NULL;
            EXCEPTION WHEN duplicate_column THEN NULL; END $$"""),
        ("kb_media_attachments", """DO $$ BEGIN
            ALTER TABLE knowledge_base ADD COLUMN media_attachments TEXT DEFAULT NULL;
            EXCEPTION WHEN duplicate_column THEN NULL; END $$"""),
        ("student_memory", """CREATE TABLE IF NOT EXISTS student_memory (
            id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE NOT NULL,
            lead_id VARCHAR(100), student_name TEXT, cpf VARCHAR(14),
            last_topic TEXT, last_summary TEXT, interaction_count INT DEFAULT 0,
            sentiment_history TEXT DEFAULT '', preferences JSONB DEFAULT '{}',
            notes TEXT DEFAULT '', first_contact_at TIMESTAMP DEFAULT NOW(),
            last_contact_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())"""),
        ("interaction_summary", """CREATE TABLE IF NOT EXISTS interaction_summary (
            id SERIAL PRIMARY KEY, phone VARCHAR(20), lead_id VARCHAR(100),
            student_name TEXT, tema VARCHAR(50), subtema VARCHAR(100),
            sentimento VARCHAR(20), resolvido VARCHAR(20), nps_implicito INT,
            resumo TEXT, mensagens_count INT DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())"""),
        ("agent_alerts", """CREATE TABLE IF NOT EXISTS agent_alerts (
            id SERIAL PRIMARY KEY, title VARCHAR(200) NOT NULL, message TEXT NOT NULL,
            category VARCHAR(50) DEFAULT 'geral', active BOOLEAN DEFAULT TRUE,
            priority INT DEFAULT 0, starts_at TIMESTAMP DEFAULT NOW(),
            expires_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW())"""),
        ("alerts_display_mode", """DO $$ BEGIN
            ALTER TABLE agent_alerts ADD COLUMN display_mode VARCHAR(20) DEFAULT 'context';
            EXCEPTION WHEN duplicate_column THEN NULL; END $$"""),
        ("agent_menus", """CREATE TABLE IF NOT EXISTS agent_menus (
            id SERIAL PRIMARY KEY, parent_id INT REFERENCES agent_menus(id) ON DELETE CASCADE,
            level VARCHAR(10) NOT NULL, menu_key VARCHAR(100) NOT NULL,
            label VARCHAR(100) NOT NULL, response_text TEXT, rag_question TEXT,
            sort_order INT DEFAULT 0, active BOOLEAN DEFAULT true,
            created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())"""),
    ]

    for name, sql in ddl_statements:
        try:
            cur.execute(sql)
            print(f"[MIGRATION] {name} OK", flush=True)
        except Exception as e:
            print(f"[MIGRATION] {name} FALHOU: {e}", flush=True)

    try:
        cur.execute("SELECT count(*) FROM agent_menus")
        if cur.fetchone()[0] == 0:
            _seed_default_menus(cur)
            print("[MIGRATION] Menus seed OK", flush=True)
    except Exception as e:
        print(f"[MIGRATION] Menus seed FALHOU: {e}", flush=True)

    try:
        cur.execute("SELECT count(*) FROM prompt_versions")
        if cur.fetchone()[0] == 0:
            cur.execute("""
                INSERT INTO prompt_versions (name, system_prompt, is_active, model, temperature, max_tokens, notes)
                VALUES (%s, %s, true, 'gpt-4o-mini', 0.2, 400, 'Prompt inicial v1')
            """, ('Prompt v1 - Original', DEFAULT_PROMPT))
            print("[MIGRATION] Prompt seed OK", flush=True)
    except Exception as e:
        print(f"[MIGRATION] Prompt seed FALHOU: {e}", flush=True)

    cur.close()
    conn.close()
    print("[MIGRATION] Tables OK", flush=True)




# --- Auth ---

def check_auth(credentials: Optional[HTTPBasicCredentials] = Depends(security)):
    if not AUTH_ENABLED:
        return True
    if not credentials:
        raise HTTPException(401, "Auth required", headers={"WWW-Authenticate": "Basic"})
    if not (secrets.compare_digest(credentials.username, ADMIN_USER) and
            secrets.compare_digest(credentials.password, ADMIN_PASS)):
        raise HTTPException(401, "Invalid credentials", headers={"WWW-Authenticate": "Basic"})
    return True


# --- OpenAI helpers ---

def generate_embedding(text: str) -> list[float]:
    client = OpenAI(api_key=OPENAI_API_KEY)
    for attempt in range(3):
        try:
            resp = client.embeddings.create(input=text[:2000], model='text-embedding-3-small', dimensions=256)
            return resp.data[0].embedding
        except Exception as e:
            if attempt < 2:
                time.sleep(1 * (attempt + 1))
                continue
            raise


def rag_search(question: str, top_k: int = 5):
    embedding = generate_embedding(question)
    emb_str = ','.join(str(x) for x in embedding)
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(f"""
            SELECT * FROM (
                SELECT id, pergunta_aluno, resposta_atendente, tema, whatsapp_buttons,
                       cosine_similarity(embedding, ARRAY[{emb_str}]::float8[]) as score
                FROM knowledge_base WHERE embedding IS NOT NULL
            ) sub ORDER BY score DESC LIMIT {top_k}
        """)
        return cur.fetchall()


def build_refs(results, min_score=0.5):
    refs = ''
    for i, r in enumerate(results):
        if float(r['score']) < min_score:
            continue
        refs += f"\n--- Ref {i+1} (tema: {r['tema'] or 'N/A'}, sim: {float(r['score']):.2f}) ---\n"
        refs += f"Pergunta: {str(r['pergunta_aluno'])[:400]}\nResposta: {str(r['resposta_atendente'])[:600]}\n"
    return refs or "Nenhuma referência encontrada."


def call_llm(question: str, system_prompt: str, model: str = 'gpt-4o-mini',
             temperature: float = 0.2, max_tokens: int = 400,
             history: Optional[List[dict]] = None):
    client = OpenAI(api_key=OPENAI_API_KEY)
    messages = [{'role': 'system', 'content': system_prompt}]
    if history:
        for h in history[-6:]:
            role = 'user' if h.get('role') == 'user' else 'assistant'
            messages.append({'role': role, 'content': h.get('text', '')})
    messages.append({'role': 'user', 'content': question})
    t0 = time.time()
    last_err = None
    for attempt in range(3):
        try:
            chat = client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=max_tokens, temperature=temperature
            )
            break
        except Exception as e:
            last_err = e
            if attempt < 2:
                time.sleep(1 * (attempt + 1))
                continue
            raise
    latency = int((time.time() - t0) * 1000)
    resp_text = chat.choices[0].message.content
    usage = chat.usage

    cm = re.search(r'\[CONFIANCA:(\d+\.?\d*)\]', resp_text)
    confidence = float(cm.group(1)) if cm else 0.0
    clean = re.sub(r'\[CONFIANCA:\d+\.?\d*\]', '', resp_text).strip()

    pricing = MODEL_PRICING.get(model, MODEL_PRICING['gpt-4o-mini'])
    cost = (usage.prompt_tokens * pricing['input'] + usage.completion_tokens * pricing['output']) / 1_000_000

    return {
        'resposta': clean,
        'confianca': confidence,
        'latency_ms': latency,
        'tokens_prompt': usage.prompt_tokens,
        'tokens_completion': usage.completion_tokens,
        'tokens_total': usage.total_tokens,
        'cost_usd': round(cost, 6),
        'model': model,
    }


def get_active_prompt():
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM prompt_versions WHERE is_active = true LIMIT 1")
        row = cur.fetchone()
        if row:
            return row
    return {'id': 0, 'system_prompt': DEFAULT_PROMPT, 'model': 'gpt-4o-mini', 'temperature': 0.3, 'max_tokens': 600}


# --- Models ---

class QACreate(BaseModel):
    pergunta: str
    resposta: str
    tema: Optional[str] = None
    whatsapp_buttons: Optional[str] = None
    media_attachments: Optional[str] = None

class QAUpdate(BaseModel):
    pergunta: Optional[str] = None
    resposta: Optional[str] = None
    tema: Optional[str] = None
    whatsapp_buttons: Optional[str] = None
    media_attachments: Optional[str] = None

class PlaygroundRequest(BaseModel):
    pergunta: str
    model: str = 'gpt-4o-mini'
    system_prompt: Optional[str] = None
    temperature: float = 0.2
    max_tokens: int = 400
    prompt_id: Optional[int] = None

class PromptCreate(BaseModel):
    name: str
    system_prompt: str
    model: str = 'gpt-4o-mini'
    temperature: float = 0.2
    max_tokens: int = 400
    notes: str = ''

class PromptUpdate(BaseModel):
    name: Optional[str] = None
    system_prompt: Optional[str] = None
    model: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    notes: Optional[str] = None

class EvalCreate(BaseModel):
    pergunta: str
    resposta_ia: str
    confianca: float
    avaliacao: str
    resposta_corrigida: Optional[str] = None
    prompt_version_id: Optional[int] = None
    model: Optional[str] = None
    latency_ms: Optional[int] = None
    tokens_used: Optional[int] = None

class TestRequest(BaseModel):
    pergunta: str
    model: Optional[str] = None
    prompt_id: Optional[int] = None
    history: Optional[List[dict]] = None
    phone: Optional[str] = None


# --- Routes: Static ---

@app.get("/api/health")
async def health_check():
    import traceback
    try:
        print("[API] health_check: tentando conectar ao DB...", flush=True)
        with get_db() as conn:
            cur = conn.cursor()
            cur.execute("SELECT 1")
            cur.close()
        print("[API] health_check: DB OK", flush=True)
        return {"status": "ok", "db": "connected"}
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[API] health_check ERRO: {e}\n{tb}", flush=True)
        return JSONResponse(status_code=500, content={"status": "error", "db": str(e), "detail": tb})


@app.get("/")
async def serve_frontend():
    return FileResponse("kb_admin.html")


# --- Routes: Stats ---

@app.get("/api/stats")
async def get_stats():
    try:
        with get_db() as conn:
            cur = conn.cursor()
            cur.execute("SELECT reltuples::bigint FROM pg_class WHERE relname = 'knowledge_base'")
            row = cur.fetchone()
            total = max(row[0], 0) if row else 0
            cur.execute("SELECT reltuples::bigint FROM pg_class WHERE relname = 'ia_interaction_log'")
            row = cur.fetchone()
            interactions = max(row[0], 0) if row else 0
            with_emb = 0
            temas = []
            sem_tema = 0
            actions = []
            avg_conf = 0
            try:
                cur.execute("SELECT count(*) FROM knowledge_base WHERE embedding IS NOT NULL")
                with_emb = cur.fetchone()[0]
            except Exception:
                pass
            try:
                cur.execute("SELECT tema, count(*) FROM knowledge_base WHERE tema IS NOT NULL GROUP BY tema ORDER BY count(*) DESC LIMIT 50")
                temas = [{'tema': r[0], 'count': r[1]} for r in cur.fetchall()]
            except Exception:
                pass
            try:
                cur.execute("SELECT acao, count(*) FROM ia_interaction_log GROUP BY acao ORDER BY count(*) DESC")
                actions = [{'action': r[0], 'count': r[1]} for r in cur.fetchall()]
            except Exception:
                pass
            try:
                cur.execute("SELECT avg(confianca) FROM ia_interaction_log WHERE confianca IS NOT NULL")
                avg_conf = cur.fetchone()[0] or 0
            except Exception:
                pass
            return {
                'total_qa': total, 'with_embedding': with_emb, 'without_embedding': total - with_emb,
                'temas': temas, 'sem_tema': sem_tema, 'total_interactions': interactions,
                'interactions_by_action': actions, 'avg_confidence': round(float(avg_conf), 3)
            }
    except Exception as e:
        print(f"[API] ERRO em /api/stats: {e}", flush=True)
        return {
            'total_qa': 0, 'with_embedding': 0, 'without_embedding': 0,
            'temas': [], 'sem_tema': 0, 'total_interactions': 0,
            'interactions_by_action': [], 'avg_confidence': 0,
            'error': str(e)
        }


@app.get("/api/temas")
async def get_temas():
    return TEMAS


@app.get("/api/models")
async def get_models():
    return [
        {'id': 'gpt-4o', 'name': 'GPT-4o', 'cost_input': 2.50, 'cost_output': 10.00},
        {'id': 'gpt-4o-mini', 'name': 'GPT-4o Mini', 'cost_input': 0.15, 'cost_output': 0.60},
        {'id': 'gpt-3.5-turbo', 'name': 'GPT-3.5 Turbo', 'cost_input': 0.50, 'cost_output': 1.50},
    ]


# --- Routes: Q&A CRUD ---

@app.get("/api/qa")
async def list_qa(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=100),
                  tema: Optional[str] = None, search: Optional[str] = None,
                  sort: str = Query('recent', pattern='^(recent|oldest|tema)$')):
    try:
        offset = (page - 1) * per_page
        conditions, params = [], []
        if tema:
            conditions.append("tema = %s"); params.append(tema)
        if search:
            conditions.append("(pergunta_aluno ILIKE %s OR resposta_atendente ILIKE %s)")
            params.extend([f'%{search}%', f'%{search}%'])
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        order = {'recent': 'created_at DESC', 'oldest': 'created_at ASC', 'tema': 'tema ASC, created_at DESC'}[sort]
        with get_db() as conn:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            if conditions:
                cur.execute(f"SELECT count(*) as cnt FROM knowledge_base {where}", params)
                total = cur.fetchone()['cnt']
            else:
                cur.execute("SELECT reltuples::bigint FROM pg_class WHERE relname = 'knowledge_base'")
                row = cur.fetchone()
                total = max(row['reltuples'], 0) if row else 0
            cur.execute(f"""SELECT id, conversation_id, pergunta_aluno, resposta_atendente, tema,
                       embedding IS NOT NULL as has_embedding, whatsapp_buttons, media_attachments, created_at FROM knowledge_base {where}
                       ORDER BY {order} LIMIT %s OFFSET %s""", params + [per_page, offset])
            items = cur.fetchall()
            for item in items:
                if item['created_at']: item['created_at'] = item['created_at'].isoformat()
            return {'items': items, 'total': total, 'page': page, 'per_page': per_page, 'pages': max((total + per_page - 1) // per_page, 1)}
    except Exception as e:
        print(f"[API] ERRO em /api/qa: {e}", flush=True)
        return {'items': [], 'total': 0, 'page': 1, 'per_page': per_page, 'pages': 0, 'error': str(e)}


@app.get("/api/qa/{qa_id}")
async def get_qa(qa_id: int):
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT id, conversation_id, pergunta_aluno, resposta_atendente, tema, embedding IS NOT NULL as has_embedding, whatsapp_buttons, media_attachments, created_at FROM knowledge_base WHERE id = %s", (qa_id,))
        item = cur.fetchone()
        if not item: raise HTTPException(404, "Q&A não encontrado")
        if item['created_at']: item['created_at'] = item['created_at'].isoformat()
        return item


@app.post("/api/qa")
async def create_qa(data: QACreate):
    if not data.pergunta.strip() or not data.resposta.strip():
        raise HTTPException(400, "Pergunta e resposta são obrigatórias")
    try:
        embedding = generate_embedding(data.pergunta)
    except Exception as e:
        raise HTTPException(500, f"Erro ao gerar embedding: {e}")
    with get_db() as conn:
        cur = conn.cursor()
        emb_str = '{' + ','.join(str(x) for x in embedding) + '}'
        cur.execute("INSERT INTO knowledge_base (pergunta_aluno, resposta_atendente, tema, embedding, conversation_id, whatsapp_buttons, media_attachments) VALUES (%s,%s,%s,%s::float8[],%s,%s,%s) RETURNING id",
                    (data.pergunta.strip(), data.resposta.strip(), data.tema, emb_str, 'manual', data.whatsapp_buttons, data.media_attachments))
        new_id = cur.fetchone()[0]
        conn.commit()
        return {'id': new_id, 'message': 'Q&A criado com embedding'}


@app.put("/api/qa/{qa_id}")
async def update_qa(qa_id: int, data: QAUpdate):
    updates, params = [], []
    if data.pergunta is not None: updates.append("pergunta_aluno = %s"); params.append(data.pergunta.strip())
    if data.resposta is not None: updates.append("resposta_atendente = %s"); params.append(data.resposta.strip())
    if data.tema is not None: updates.append("tema = %s"); params.append(data.tema)
    if data.whatsapp_buttons is not None: updates.append("whatsapp_buttons = %s"); params.append(data.whatsapp_buttons if data.whatsapp_buttons else None)
    if data.media_attachments is not None: updates.append("media_attachments = %s"); params.append(data.media_attachments if data.media_attachments else None)
    if not updates: raise HTTPException(400, "Nenhum campo para atualizar")
    regen = data.pergunta is not None
    if regen:
        try:
            emb = generate_embedding(data.pergunta)
            updates.append("embedding = %s::float8[]"); params.append('{' + ','.join(str(x) for x in emb) + '}')
        except Exception: pass
    params.append(qa_id)
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE knowledge_base SET {', '.join(updates)} WHERE id = %s", params)
        if cur.rowcount == 0: raise HTTPException(404)
        conn.commit()
        return {'message': 'Atualizado', 'embedding_regenerated': regen}


@app.delete("/api/qa/{qa_id}")
async def delete_qa(qa_id: int):
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM knowledge_base WHERE id = %s", (qa_id,))
        if cur.rowcount == 0: raise HTTPException(404)
        conn.commit()
        return {'message': 'Deletado'}


# --- Flow Logic (Hybrid Bot+IA) ---

GREETING_WORDS = {
    'oi', 'olá', 'ola', 'oii', 'oiii', 'hello', 'hi', 'hey', 'fala', 'salve', 'opa', 'eae',
    'bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'tudo bom', 'como vai',
    'oi bom dia', 'oi boa tarde', 'oi boa noite',
}

RESOLVED_WORDS = {'sim resolveu', 'resolveu', 'sim obrigado', 'sim obrigada', 'sim!', 'resolvido', 'era isso'}
ESCALATE_WORDS = {'falar com atendente', 'atendente', 'humano', 'falar com alguem', 'transferir'}
CLOSING_WORDS = {'obrigado', 'obrigada', 'valeu', 'vlw', 'tchau', 'até mais', 'ate mais', 'brigado', 'brigada'}

GREETING_MENU = {
    'type': 'flow_menu',
    'text': 'Olá! Bem-vindo ao Suporte ao Aluno da *Cruzeiro do Sul* 😊\n\nComo posso te ajudar?',
    'buttons': [
        {'id': 'acesso', 'title': '🔑 Acesso Portal/App'},
        {'id': 'financeiro', 'title': '💰 Financeiro'},
        {'id': 'academico', 'title': '📚 Aulas e Conteúdo'},
    ],
    'buttons2': [
        {'id': 'documentos', 'title': '📄 Documentos'},
        {'id': 'rematricula', 'title': '🔄 Rematrícula'},
        {'id': 'atendente', 'title': '👤 Falar com atendente'},
    ]
}

SUBMENU = {
    'financeiro': {
        'type': 'flow_submenu',
        'text': 'Sobre *Financeiro*, qual sua dúvida?',
        'buttons': [
            {'id': 'boleto', 'title': '🧾 Boleto / Pagamento'},
            {'id': 'mensalidade', 'title': '💳 Mensalidade / Valores'},
            {'id': 'negociacao', 'title': '🤝 Negociação / Parcelamento'},
        ],
        'buttons2': [
            {'id': 'reembolso', 'title': '💸 Reembolso'},
            {'id': 'fin_atendente', 'title': '👤 Falar com atendente'},
        ]
    },
    'acesso': {
        'type': 'flow_submenu',
        'text': 'Sobre *Acesso*, qual sua dúvida?',
        'buttons': [
            {'id': 'primeiro_acesso', 'title': '🆕 Primeiro acesso'},
            {'id': 'esqueci_senha', 'title': '🔑 Esqueci minha senha'},
            {'id': 'app_duda', 'title': '📱 App Duda'},
        ],
        'buttons2': [
            {'id': 'blackboard', 'title': '🖥️ Blackboard / AVA'},
            {'id': 'acesso_atendente', 'title': '👤 Falar com atendente'},
        ]
    },
    'academico': {
        'type': 'flow_submenu',
        'text': 'Sobre *Aulas e Conteúdo*, qual sua dúvida?',
        'buttons': [
            {'id': 'inicio_aulas', 'title': '📅 Início das aulas'},
            {'id': 'disciplinas', 'title': '📖 Disciplinas / Grade'},
            {'id': 'provas', 'title': '📝 Provas / Atividades'},
        ],
        'buttons2': [
            {'id': 'material', 'title': '📚 Material didático'},
            {'id': 'acad_atendente', 'title': '👤 Falar com atendente'},
        ]
    },
    'documentos': {
        'type': 'flow_submenu',
        'text': 'Sobre *Documentos*, o que precisa?',
        'buttons': [
            {'id': 'declaracao', 'title': '📋 Declaração de matrícula'},
            {'id': 'historico', 'title': '📄 Histórico escolar'},
            {'id': 'enviar_doc', 'title': '📎 Enviar documentos'},
        ],
        'buttons2': [
            {'id': 'doc_atendente', 'title': '👤 Falar com atendente'},
        ]
    },
    'rematricula': {
        'type': 'flow_submenu',
        'text': 'Sobre *Rematrícula*, qual sua dúvida?',
        'buttons': [
            {'id': 'como_rematricular', 'title': '🔄 Como rematricular'},
            {'id': 'prazo_rematricula', 'title': '📅 Prazo de rematrícula'},
            {'id': 'rematricula_atendente', 'title': '👤 Falar com atendente'},
        ]
    },
}

SUBMENU_L3 = {
    'boleto': {
        'type': 'flow_submenu',
        'text': 'Sobre *Boleto / Pagamento*:',
        'buttons': [
            {'id': 'boleto_2via', 'title': '📄 Segunda via do boleto'},
            {'id': 'boleto_pix', 'title': '💠 Pagar com PIX'},
            {'id': 'boleto_vencido', 'title': '⚠️ Boleto vencido'},
        ],
        'buttons2': [
            {'id': 'boleto_atendente', 'title': '👤 Falar com atendente'},
        ]
    },
    'mensalidade': {
        'type': 'flow_submenu',
        'text': 'Sobre *Mensalidade / Valores*:',
        'buttons': [
            {'id': 'mens_valor', 'title': '💲 Valor da mensalidade'},
            {'id': 'mens_desconto', 'title': '🏷️ Desconto / Bolsa'},
            {'id': 'mens_reajuste', 'title': '📈 Reajuste de mensalidade'},
        ],
        'buttons2': [
            {'id': 'mens_atendente', 'title': '👤 Falar com atendente'},
        ]
    },
    'negociacao': {
        'type': 'flow_submenu',
        'text': 'Sobre *Negociação / Parcelamento*:',
        'buttons': [
            {'id': 'neg_parcelar', 'title': '💳 Parcelar dívida'},
            {'id': 'neg_acordo', 'title': '🤝 Fazer acordo'},
            {'id': 'neg_inadimplente', 'title': '🔒 Estou inadimplente'},
        ],
        'buttons2': [
            {'id': 'neg_atendente', 'title': '👤 Falar com atendente'},
        ]
    },
    'primeiro_acesso': {
        'type': 'flow_submenu',
        'text': 'Sobre *Primeiro Acesso*:',
        'buttons': [
            {'id': 'pa_credenciais', 'title': '📧 Não recebi credenciais'},
            {'id': 'pa_onde', 'title': '🌐 Onde me cadastro'},
            {'id': 'pa_email', 'title': '📨 Email acadêmico'},
        ],
        'buttons2': [
            {'id': 'pa_atendente', 'title': '👤 Falar com atendente'},
        ]
    },
    'provas': {
        'type': 'flow_submenu',
        'text': 'Sobre *Provas e Atividades*:',
        'buttons': [
            {'id': 'prova_data', 'title': '📅 Datas das provas'},
            {'id': 'prova_prazo', 'title': '⏰ Prazo de atividades'},
            {'id': 'prova_nota', 'title': '📊 Ver minhas notas'},
        ],
        'buttons2': [
            {'id': 'prova_atendente', 'title': '👤 Falar com atendente'},
        ]
    },
}

SUBMENU_TO_QUESTION = {
    'boleto_2via': 'como gerar segunda via do boleto de pagamento',
    'boleto_pix': 'como pagar a mensalidade com PIX',
    'boleto_vencido': 'meu boleto venceu o que fazer como pagar boleto vencido',
    'mens_valor': 'qual o valor da mensalidade e como consultar valores',
    'mens_desconto': 'como conseguir desconto ou bolsa na mensalidade',
    'mens_reajuste': 'por que a mensalidade teve reajuste e como contestar',
    'neg_parcelar': 'como parcelar mensalidades em atraso',
    'neg_acordo': 'como fazer acordo de pagamento de dívida',
    'neg_inadimplente': 'estou inadimplente o que acontece como regularizar',
    'reembolso': 'como solicitar reembolso de pagamento',
    'pa_credenciais': 'não recebi meus dados de acesso credenciais do portal',
    'pa_onde': 'onde faço cadastro para acessar o portal do aluno',
    'pa_email': 'qual meu email acadêmico e como acessar',
    'esqueci_senha': 'esqueci minha senha do portal como redefinir',
    'app_duda': 'como baixar e acessar o app Duda',
    'blackboard': 'como acessar o Blackboard ou ambiente virtual de aprendizagem',
    'inicio_aulas': 'quando começam as aulas do semestre',
    'disciplinas': 'como ver minhas disciplinas e grade curricular',
    'prova_data': 'quando são as datas das provas do semestre',
    'prova_prazo': 'qual o prazo para entrega de atividades',
    'prova_nota': 'como ver minhas notas e conceitos',
    'material': 'como acessar o material didático das aulas',
    'declaracao': 'como emitir declaração de matrícula ou vínculo',
    'historico': 'como solicitar histórico escolar',
    'enviar_doc': 'como enviar documentos para a secretaria',
    'como_rematricular': 'como fazer a rematrícula para o próximo semestre',
    'prazo_rematricula': 'qual o prazo para rematrícula do semestre',
}

MAIN_MENU_KEYS = {
    'acesso portal/app': 'acesso', 'acesso': 'acesso',
    'financeiro': 'financeiro',
    'aulas e conteúdo': 'academico', 'aulas': 'academico',
    'documentos': 'documentos',
    'rematrícula': 'rematricula', 'rematricula': 'rematricula',
}

L2_TO_L3_KEYS = {
    'boleto / pagamento': 'boleto', 'boleto': 'boleto',
    'mensalidade / valores': 'mensalidade', 'mensalidade': 'mensalidade',
    'negociação / parcelamento': 'negociacao', 'negociacao / parcelamento': 'negociacao',
    'primeiro acesso': 'primeiro_acesso',
    'provas / atividades': 'provas', 'provas': 'provas',
}


def generate_flow_buttons(pergunta: str, confianca: float, history: list = None):
    q = pergunta.lower().strip().rstrip('!?.,').strip()
    stripped = q.replace('🔑 ', '').replace('💰 ', '').replace('📚 ', '').replace('📄 ', '').replace('🔄 ', '').replace('👤 ', '').replace('🧾 ', '').replace('💳 ', '').replace('🤝 ', '').replace('💸 ', '').replace('🆕 ', '').replace('📱 ', '').replace('🖥️ ', '').replace('📅 ', '').replace('📖 ', '').replace('📝 ', '').replace('📚 ', '').replace('📋 ', '').replace('📎 ', '').replace('💬 ', '').replace('✅ ', '').replace('💬', '').replace('✅', '').lower().strip()

    # Greeting detection
    words = q.split()
    is_greet = q in GREETING_WORDS or (len(words) <= 3 and any(w in GREETING_WORDS for w in words))
    if is_greet and (not history or len(history) <= 1):
        return GREETING_MENU

    # Pre-check: if text matches a leaf button (SUBMENU_TO_QUESTION), let RAG handle it
    for cat in list(SUBMENU.values()) + list(SUBMENU_L3.values()):
        for b in cat.get('buttons', []) + cat.get('buttons2', []):
            if b['id'] in SUBMENU_TO_QUESTION:
                clean = b['title'].lower()
                for em in '🔑💰📚📄🔄👤🧾💳🤝💸🆕📱🖥️📅📖📝📋📎💲🏷️📈🔒💠⚠️📧🌐📨📊⏰':
                    clean = clean.replace(em + ' ', '').replace(em, '')
                if clean.strip() and clean.strip() in stripped:
                    return None

    # Main menu -> sub-menu (level 2)
    for menu_key, submenu_key in MAIN_MENU_KEYS.items():
        if menu_key in stripped:
            return SUBMENU[submenu_key]

    # Level 2 -> Level 3 sub-menu
    for l2_key, l3_key in L2_TO_L3_KEYS.items():
        if l2_key in stripped and l3_key in SUBMENU_L3:
            return SUBMENU_L3[l3_key]

    # "Sim, resolveu" / resolved
    if any(w in q for w in RESOLVED_WORDS) or (q in ('sim', 'si', 'sím') and history and len(history) >= 2):
        return {
            'type': 'flow_resolved',
            'text': 'Que bom que pude ajudar! 😊\n\nTem mais alguma dúvida?',
            'buttons': [
                {'id': 'outra', 'title': '💬 Tenho outra dúvida'},
                {'id': 'encerrar', 'title': '✅ Não, obrigado!'},
            ]
        }

    # Explicit escalation request
    if any(w in q for w in ESCALATE_WORDS):
        return {
            'type': 'flow_escalate',
            'text': 'Vou te transferir para um atendente agora. Por favor, aguarde um momento.',
            'buttons': [
                {'id': 'outra', 'title': '💬 Tenho outra dúvida'},
            ]
        }

    # "Não, obrigado" / closing
    close_match = any(w in q for w in CLOSING_WORDS) or q in ('não obrigado', 'nao obrigado', 'encerrar', 'não', 'nao',
                                                               'não preciso', 'nao preciso', 'pode encerrar', 'fechar')
    if close_match and history and len(history) >= 2:
        already_closed = any('Obrigado pelo contato' in h.get('text', '') or 'Até logo' in h.get('text', '') for h in history if h.get('role') == 'bot')
        if already_closed:
            return {
                'type': 'flow_close',
                'text': 'Até logo! Quando precisar, é só chamar. 😊',
                'buttons': []
            }
        return {
            'type': 'flow_close',
            'text': 'Obrigado pelo contato! Qualquer dúvida é só nos chamar novamente. Até mais! 😊',
            'buttons': []
        }

    # "Outra dúvida" / restart — vai direto pro menu de categorias
    outra_phrases = ('outra dúvida', 'outra duvida', 'tenho outra', 'outra pergunta', 'mais uma duvida', 'mais uma dúvida')
    if any(p in stripped for p in outra_phrases) or stripped in ('outra', 'menu', 'opcoes', 'opções'):
        return {
            'type': 'flow_menu',
            'text': 'Escolha o assunto abaixo 👇',
            'buttons': GREETING_MENU['buttons'],
            'buttons2': GREETING_MENU['buttons2'],
        }

    # After AI response - add follow-up buttons based on confidence
    if confianca >= 0.7:
        return {
            'type': 'flow_followup',
            'buttons': [
                {'id': 'resolveu', 'title': '✅ Resolveu!'},
                {'id': 'outra', 'title': '💬 Outra dúvida'},
                {'id': 'atendente', 'title': '👤 Falar com atendente'},
            ]
        }
    elif confianca >= 0.4:
        return {
            'type': 'flow_followup',
            'buttons': [
                {'id': 'resolveu', 'title': '✅ Ajudou!'},
                {'id': 'atendente', 'title': '👤 Falar com atendente'},
            ]
        }
    else:
        return {
            'type': 'flow_followup',
            'buttons': [
                {'id': 'outra', 'title': '💬 Tenho outra dúvida'},
            ]
        }


# --- Routes: Test / Playground ---

@app.post("/api/test")
async def test_question(data: TestRequest):
    if not data.pergunta.strip(): raise HTTPException(400, "Pergunta é obrigatória")

    try:
        q = data.pergunta.strip()
        q_lower = q.lower().rstrip('!?.,').strip()

        # --- Pre-check: Flow-only responses (no LLM needed) ---
        pre_flow = generate_flow_buttons(q, 1.0, data.history)

        if pre_flow and pre_flow.get('type') in ('flow_resolved', 'flow_close', 'flow_escalate', 'flow_submenu'):
            return {
                'resposta': pre_flow['text'],
                'confianca': 1.0,
                'latency_ms': 0,
                'tokens_prompt': 0, 'tokens_completion': 0, 'tokens_total': 0,
                'cost_usd': 0,
                'model': 'flow',
                'whatsapp_buttons': None,
                'flow_buttons': pre_flow,
                'referencias': []
            }

        if pre_flow and pre_flow.get('type') == 'flow_menu':
            return {
                'resposta': pre_flow['text'],
                'confianca': 1.0,
                'latency_ms': 0,
                'tokens_prompt': 0, 'tokens_completion': 0, 'tokens_total': 0,
                'cost_usd': 0,
                'model': 'flow',
                'whatsapp_buttons': None,
                'flow_buttons': pre_flow,
                'referencias': []
            }

        # --- Translate button clicks (L2/L3) to real questions for RAG ---
        search_query = q
        stripped_q = q_lower
        for emoji in '🔑💰📚📄🔄👤🧾💳🤝💸🆕📱🖥️📅📖📝📋📎💲🏷️📈🔒💠⚠️📧🌐📨📊⏰':
            stripped_q = stripped_q.replace(emoji + ' ', '').replace(emoji, '')
        stripped_q = stripped_q.strip()

        all_buttons = {}
        for cat in list(SUBMENU.values()) + list(SUBMENU_L3.values()):
            for b in cat.get('buttons', []) + cat.get('buttons2', []):
                if b['id'] in SUBMENU_TO_QUESTION:
                    clean = b['title'].lower()
                    for emoji in '🔑💰📚📄🔄👤🧾💳🤝💸🆕📱🖥️📅📖📝📋📎💲🏷️📈🔒💠⚠️📧🌐📨📊⏰':
                        clean = clean.replace(emoji + ' ', '').replace(emoji, '')
                    all_buttons[clean.strip()] = SUBMENU_TO_QUESTION[b['id']]

        for btn_text, real_question in all_buttons.items():
            if btn_text and btn_text in stripped_q:
                search_query = real_question
                break

        # For short replies with history context
        if data.history and len(search_query) < 30 and search_query == q:
            last_bot = None
            for h in reversed(data.history or []):
                if h.get('role') == 'bot':
                    last_bot = h.get('text', '')[:200]
                    break
            if last_bot:
                search_query = f"{last_bot} {search_query}"

        results = rag_search(search_query)
        refs = build_refs(results)

        history_text = ''
        if data.history:
            for h in data.history[-4:]:
                role = 'Aluno' if h.get('role') == 'user' else 'Assistente'
                history_text += f"{role}: {h.get('text', '')[:200]}\n"

        # Build student/memory/sentiment context
        student_ctx = "## ALUNO: Modo simulador (sem telefone)"
        memory_ctx = ""
        sentiment_ctx = ""
        student_info = None

        if data.phone:
            clean_phone = data.phone.replace('+', '').replace(' ', '').replace('-', '')
            h_crm = {'Authorization': f'Bearer {DCZ_TOKEN}', 'Content-Type': 'application/json'}
            try:
                r_crm = http_requests.get(f'https://crm.g1.datacrazy.io/api/crm/leads',
                                         headers=h_crm, params={'search': clean_phone, 'limit': 1}, timeout=10)
                if r_crm.status_code == 200:
                    leads = r_crm.json().get('data', [])
                    if leads:
                        ld = leads[0]
                        student_info = {'name': ld.get('name', ''), 'cpf': ld.get('taxId', ''),
                                       'tags': [t.get('name', '') for t in ld.get('tags', [])]}
                        fname = ld.get('name', '').split()[0].capitalize() if ld.get('name') else 'aluno'
                        student_ctx = f"## DADOS DO ALUNO:\n- Nome: {ld.get('name','')}\n- Tags: {', '.join(student_info['tags'])}\n\nChame o aluno de *{fname}*."
            except Exception:
                pass

            with get_db() as conn:
                cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
                cur.execute("SELECT * FROM student_memory WHERE phone LIKE %s", (f'%{clean_phone[-11:]}%',))
                mem = cur.fetchone()
            if mem:
                memory_ctx = f"## MEMÓRIA DO ALUNO:\n- Interações: {mem['interaction_count']}\n- Último assunto: {mem.get('last_topic','')}\n- Resumo anterior: {mem.get('last_summary','')}"

        # Sentiment detection
        frustration_words = ['não consigo', 'nao consigo', 'impossível', 'absurdo', 'problema', 'erro',
                            'urgente', 'raiva', 'frustrado', 'horrível', 'já tentei', 'nunca funciona']
        q_text = data.pergunta.lower()
        frust = sum(1 for w in frustration_words if w in q_text)
        if frust >= 2:
            sentiment_ctx = "## SENTIMENTO: FRUSTRADO\n- Valide o sentimento antes de responder. Priorize resolução."
        elif frust == 1:
            sentiment_ctx = "## SENTIMENTO: PREOCUPADO\n- Seja atencioso e detalhado."

        if data.prompt_id:
            with get_db() as conn:
                cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
                cur.execute("SELECT * FROM prompt_versions WHERE id = %s", (data.prompt_id,))
                pv = cur.fetchone()
            if pv:
                prompt_text = pv['system_prompt'].replace('{references}', refs).replace('{history}', history_text)
                prompt_text = prompt_text.replace('{student_context}', student_ctx).replace('{memory_context}', memory_ctx).replace('{sentiment_context}', sentiment_ctx)
                model = data.model or pv['model']
                llm = call_llm(data.pergunta, prompt_text, model, pv['temperature'], pv['max_tokens'], data.history)
            else:
                raise HTTPException(404, "Prompt não encontrado")
        else:
            active = get_active_prompt()
            prompt_text = active['system_prompt'].replace('{references}', refs).replace('{history}', history_text)
            prompt_text = prompt_text.replace('{student_context}', student_ctx).replace('{memory_context}', memory_ctx).replace('{sentiment_context}', sentiment_ctx)
            model = data.model or active['model']
            llm = call_llm(data.pergunta, prompt_text, model, active['temperature'], active['max_tokens'], data.history)

        # Determine follow-up buttons based on flow state
        flow_buttons = generate_flow_buttons(data.pergunta, llm['confianca'], data.history)

        # KB-defined buttons (from bot flow import) - only if no flow buttons
        best_wa = None
        if not flow_buttons:
            for r in results:
                if r.get('whatsapp_buttons') and float(r['score']) >= 0.75:
                    best_wa = r['whatsapp_buttons']
                    break

        return {
            **llm,
            'whatsapp_buttons': best_wa,
            'flow_buttons': flow_buttons,
            'referencias': [
                {'id': r['id'], 'pergunta': str(r['pergunta_aluno'])[:200], 'resposta': str(r['resposta_atendente'])[:300],
                 'tema': r['tema'], 'score': round(float(r['score']), 3),
                 'whatsapp_buttons': r.get('whatsapp_buttons')} for r in results
            ]
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=200, content={
            'resposta': 'Desculpe, ocorreu um erro temporário ao processar sua pergunta. Por favor, tente novamente.',
            'confianca': 0,
            'latency_ms': 0,
            'tokens_prompt': 0, 'tokens_completion': 0, 'tokens_total': 0,
            'cost_usd': 0,
            'model': 'erro',
            'whatsapp_buttons': None,
            'flow_buttons': None,
            'referencias': [],
            'erro': str(e)
        })


@app.post("/api/playground")
async def playground(data: PlaygroundRequest):
    if not data.pergunta.strip(): raise HTTPException(400, "Pergunta é obrigatória")
    results = rag_search(data.pergunta)
    refs = build_refs(results)

    empty_ctx = {'student_context': '', 'memory_context': '', 'sentiment_context': ''}
    if data.system_prompt:
        prompt_text = data.system_prompt.replace('{references}', refs).replace('{history}', '')
    elif data.prompt_id:
        with get_db() as conn:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("SELECT system_prompt FROM prompt_versions WHERE id = %s", (data.prompt_id,))
            row = cur.fetchone()
        prompt_text = (row['system_prompt'] if row else DEFAULT_PROMPT).replace('{references}', refs).replace('{history}', '')
    else:
        prompt_text = DEFAULT_PROMPT.replace('{references}', refs)
    for k, v in empty_ctx.items():
        prompt_text = prompt_text.replace('{' + k + '}', v)

    llm = call_llm(data.pergunta, prompt_text, data.model, data.temperature, data.max_tokens)
    return {
        **llm,
        'referencias': [
            {'id': r['id'], 'pergunta': str(r['pergunta_aluno'])[:200], 'resposta': str(r['resposta_atendente'])[:300],
             'tema': r['tema'], 'score': round(float(r['score']), 3)} for r in results
        ]
    }


# --- Routes: Prompts CRUD ---

@app.get("/api/prompts")
async def list_prompts():
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT id, name, is_active, model, temperature, max_tokens, notes, created_at, length(system_prompt) as prompt_length FROM prompt_versions ORDER BY created_at DESC")
        items = cur.fetchall()
        for i in items:
            if i['created_at']: i['created_at'] = i['created_at'].isoformat()
            i['temperature'] = float(i['temperature']) if i['temperature'] else 0.2
        return items


@app.get("/api/prompts/{pid}")
async def get_prompt(pid: int):
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM prompt_versions WHERE id = %s", (pid,))
        item = cur.fetchone()
        if not item: raise HTTPException(404)
        if item['created_at']: item['created_at'] = item['created_at'].isoformat()
        item['temperature'] = float(item['temperature']) if item['temperature'] else 0.2
        return item


@app.post("/api/prompts")
async def create_prompt(data: PromptCreate):
    if not data.name.strip() or not data.system_prompt.strip(): raise HTTPException(400, "Nome e prompt obrigatórios")
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("INSERT INTO prompt_versions (name, system_prompt, model, temperature, max_tokens, notes) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                    (data.name.strip(), data.system_prompt, data.model, data.temperature, data.max_tokens, data.notes))
        pid = cur.fetchone()[0]
        conn.commit()
        return {'id': pid, 'message': 'Prompt criado'}


@app.put("/api/prompts/{pid}")
async def update_prompt(pid: int, data: PromptUpdate):
    updates, params = [], []
    if data.name is not None: updates.append("name=%s"); params.append(data.name)
    if data.system_prompt is not None: updates.append("system_prompt=%s"); params.append(data.system_prompt)
    if data.model is not None: updates.append("model=%s"); params.append(data.model)
    if data.temperature is not None: updates.append("temperature=%s"); params.append(data.temperature)
    if data.max_tokens is not None: updates.append("max_tokens=%s"); params.append(data.max_tokens)
    if data.notes is not None: updates.append("notes=%s"); params.append(data.notes)
    if not updates: raise HTTPException(400)
    params.append(pid)
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE prompt_versions SET {', '.join(updates)} WHERE id=%s", params)
        if cur.rowcount == 0: raise HTTPException(404)
        conn.commit()
        return {'message': 'Atualizado'}


@app.post("/api/prompts/{pid}/activate")
async def activate_prompt(pid: int):
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE prompt_versions SET is_active = false WHERE is_active = true")
        cur.execute("UPDATE prompt_versions SET is_active = true WHERE id = %s", (pid,))
        if cur.rowcount == 0: raise HTTPException(404)
        conn.commit()
        return {'message': 'Prompt ativado'}


@app.post("/api/prompts/{pid}/duplicate")
async def duplicate_prompt(pid: int):
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM prompt_versions WHERE id = %s", (pid,))
        orig = cur.fetchone()
        if not orig: raise HTTPException(404)
        cur.execute("INSERT INTO prompt_versions (name, system_prompt, model, temperature, max_tokens, notes) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                    (f"{orig['name']} (cópia)", orig['system_prompt'], orig['model'], orig['temperature'], orig['max_tokens'], orig['notes']))
        new_id = cur.fetchone()[0]
        conn.commit()
        return {'id': new_id, 'message': 'Duplicado'}


@app.delete("/api/prompts/{pid}")
async def delete_prompt(pid: int):
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT is_active FROM prompt_versions WHERE id = %s", (pid,))
        row = cur.fetchone()
        if not row: raise HTTPException(404)
        if row[0]: raise HTTPException(400, "Não é possível deletar o prompt ativo")
        cur.execute("DELETE FROM prompt_versions WHERE id = %s", (pid,))
        conn.commit()
        return {'message': 'Deletado'}


# --- Routes: Evaluations ---

@app.post("/api/evaluations")
async def create_evaluation(data: EvalCreate):
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("""INSERT INTO chat_evaluations (pergunta, resposta_ia, confianca, avaliacao, resposta_corrigida, prompt_version_id, model, latency_ms, tokens_used)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                    (data.pergunta, data.resposta_ia, data.confianca, data.avaliacao, data.resposta_corrigida,
                     data.prompt_version_id, data.model, data.latency_ms, data.tokens_used))
        eid = cur.fetchone()[0]
        conn.commit()
        return {'id': eid}


@app.get("/api/evaluations")
async def list_evaluations(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    offset = (page - 1) * per_page
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT count(*) as cnt FROM chat_evaluations")
        total = cur.fetchone()['cnt']
        cur.execute("SELECT * FROM chat_evaluations ORDER BY created_at DESC LIMIT %s OFFSET %s", (per_page, offset))
        items = cur.fetchall()
        for i in items:
            if i['created_at']: i['created_at'] = i['created_at'].isoformat()
            if i['confianca']: i['confianca'] = float(i['confianca'])
        return {'items': items, 'total': total, 'page': page, 'pages': (total + per_page - 1) // per_page}


# --- Routes: Analytics ---

@app.get("/api/analytics")
async def get_analytics():
    empty = {
        'eval_stats': {}, 'timeline': [], 'tema_failures': [],
        'top_escalations': [], 'total_tokens': 0, 'estimated_cost_usd': 0,
        'prompt_comparison': [],
    }
    try:
        with get_db() as conn:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

            cur.execute("SELECT avaliacao, count(*) as cnt FROM chat_evaluations GROUP BY avaliacao")
            eval_stats = {r['avaliacao']: r['cnt'] for r in cur.fetchall()}

            cur.execute("""
                SELECT date_trunc('day', created_at)::date as day, avg(confianca) as avg_conf, count(*) as cnt
                FROM ia_interaction_log WHERE confianca IS NOT NULL
                GROUP BY day ORDER BY day DESC LIMIT 30
            """)
            timeline = [{'day': str(r['day']), 'avg_conf': round(float(r['avg_conf']), 3), 'count': r['cnt']} for r in cur.fetchall()]

            cur.execute("""
                SELECT kb.tema, count(*) as total,
                       count(*) FILTER (WHERE il.confianca < 0.5) as low_conf
                FROM ia_interaction_log il
                LEFT JOIN knowledge_base kb ON kb.conversation_id = il.conversation_id
                WHERE kb.tema IS NOT NULL
                GROUP BY kb.tema ORDER BY low_conf DESC LIMIT 15
            """)
            tema_failures = [{'tema': r['tema'], 'total': r['total'], 'low_conf': r['low_conf']} for r in cur.fetchall()]

            cur.execute("""
                SELECT pergunta_recebida, confianca, acao, created_at
                FROM ia_interaction_log
                WHERE acao LIKE 'escalate%%'
                ORDER BY created_at DESC LIMIT 10
            """)
            escalations = []
            for r in cur.fetchall():
                escalations.append({
                    'pergunta': r['pergunta_recebida'][:150] if r['pergunta_recebida'] else '',
                    'confianca': float(r['confianca']) if r['confianca'] else 0,
                    'acao': r['acao'],
                    'created_at': r['created_at'].isoformat() if r['created_at'] else ''
                })

            cur.execute("SELECT sum(tokens_used) as total_tokens, count(*) as cnt FROM chat_evaluations WHERE tokens_used > 0")
            cost_row = cur.fetchone()
            total_tokens = cost_row['total_tokens'] or 0
            est_cost = (total_tokens * 0.60) / 1_000_000

            cur.execute("""
                SELECT prompt_version_id, model, avg(confianca) as avg_conf, count(*) as cnt
                FROM chat_evaluations WHERE prompt_version_id IS NOT NULL
                GROUP BY prompt_version_id, model
            """)
            prompt_comparison = [{'prompt_id': r['prompt_version_id'], 'model': r['model'],
                                 'avg_conf': round(float(r['avg_conf']), 3) if r['avg_conf'] else 0,
                                 'count': r['cnt']} for r in cur.fetchall()]

            return {
                'eval_stats': eval_stats,
                'timeline': timeline,
                'tema_failures': tema_failures,
                'top_escalations': escalations,
                'total_tokens': total_tokens,
                'estimated_cost_usd': round(est_cost, 4),
                'prompt_comparison': prompt_comparison,
            }
    except Exception as e:
        print(f"[API] ERRO em /api/analytics: {e}", flush=True)
        empty['error'] = str(e)
        return empty


# --- Routes: Interactions ---

@app.get("/api/interactions")
async def list_interactions(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    offset = (page - 1) * per_page
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT count(*) as cnt FROM ia_interaction_log")
        total = cur.fetchone()['cnt']
        cur.execute("SELECT * FROM ia_interaction_log ORDER BY created_at DESC LIMIT %s OFFSET %s", (per_page, offset))
        items = cur.fetchall()
        for i in items:
            if i['created_at']: i['created_at'] = i['created_at'].isoformat()
            if i.get('confianca'): i['confianca'] = float(i['confianca'])
        return {'items': items, 'total': total, 'page': page, 'pages': (total + per_page - 1) // per_page}


# --- Routes: Import ---

@app.post("/api/import/csv")
async def import_csv(file: UploadFile = File(...)):
    content = await file.read()
    text = content.decode('utf-8-sig')
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    if not rows: raise HTTPException(400, "CSV vazio")

    required = {'pergunta', 'resposta'}
    headers = set(rows[0].keys())
    if not required.issubset(headers):
        raise HTTPException(400, f"CSV deve ter colunas: pergunta, resposta. Encontradas: {headers}")

    imported, errors = 0, 0
    with get_db() as conn:
        cur = conn.cursor()
        for row in rows:
            p, r = row.get('pergunta', '').strip(), row.get('resposta', '').strip()
            tema = row.get('tema', '').strip() or None
            if not p or not r: errors += 1; continue
            try:
                emb = generate_embedding(p)
                emb_str = '{' + ','.join(str(x) for x in emb) + '}'
                cur.execute("INSERT INTO knowledge_base (pergunta_aluno, resposta_atendente, tema, embedding, conversation_id) VALUES (%s,%s,%s,%s::float8[],%s)",
                            (p, r, tema, emb_str, 'csv_import'))
                imported += 1
                if imported % 10 == 0: conn.commit()
            except Exception:
                errors += 1
        conn.commit()
    return {'imported': imported, 'errors': errors, 'total_rows': len(rows)}


@app.post("/api/import/templates")
async def import_templates():
    h = {'Authorization': f'Bearer {DCZ_TOKEN}', 'Content-Type': 'application/json'}
    r = http_requests.get(f'{DCZ_MSG}/messaging/templates', headers=h, timeout=15)
    if r.status_code != 200:
        raise HTTPException(502, f"DataCrazy retornou {r.status_code}")
    templates = r.json().get('data', [])

    preview = []
    for t in templates:
        name = t.get('name', '').strip()
        body = t.get('body', '').strip()
        tid = t.get('id', '')
        attachments = t.get('attachments', [])
        if not body or len(body) < 20 or name.lower() in ('teste', 'test'):
            continue
        preview.append({
            'id': tid, 'name': name, 'body': body[:300],
            'full_body': body, 'attachments_count': len(attachments),
            'attachments': [a.get('filename', a.get('url', '')) for a in attachments]
        })
    return {'count': len(preview), 'templates': preview}


@app.post("/api/import/templates/confirm")
async def confirm_import_templates(template_ids: List[str]):
    h = {'Authorization': f'Bearer {DCZ_TOKEN}', 'Content-Type': 'application/json'}
    r = http_requests.get(f'{DCZ_MSG}/messaging/templates', headers=h, timeout=15)
    templates = {t['id']: t for t in r.json().get('data', [])}

    imported, errors = 0, 0
    with get_db() as conn:
        cur = conn.cursor()
        for tid in template_ids:
            t = templates.get(tid)
            if not t: continue
            name, body = t.get('name', ''), t.get('body', '')
            pergunta = f"Informação sobre: {name}"
            att_info = ''
            atts = t.get('attachments', [])
            if atts:
                att_info = '\n\n[Anexos: ' + ', '.join(a.get('filename', a.get('url', '')) for a in atts) + ']'
            try:
                emb = generate_embedding(pergunta)
                emb_str = '{' + ','.join(str(x) for x in emb) + '}'
                cur.execute("INSERT INTO knowledge_base (pergunta_aluno, resposta_atendente, tema, embedding, conversation_id) VALUES (%s,%s,%s,%s::float8[],%s)",
                            (pergunta, body + att_info, 'OUTRO', emb_str, f'template:{tid}'))
                imported += 1
            except Exception:
                errors += 1
        conn.commit()
    return {'imported': imported, 'errors': errors}


# --- Routes: Gaps & Duplicates ---

@app.get("/api/gaps")
async def find_gaps():
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT pergunta_recebida, confianca, acao, created_at
            FROM ia_interaction_log
            WHERE confianca IS NOT NULL AND confianca < 0.5
            ORDER BY created_at DESC LIMIT 50
        """)
        gaps = []
        for r in cur.fetchall():
            gaps.append({
                'pergunta': r['pergunta_recebida'][:200] if r['pergunta_recebida'] else '',
                'confianca': float(r['confianca']) if r['confianca'] else 0,
                'acao': r['acao'],
                'created_at': r['created_at'].isoformat() if r['created_at'] else ''
            })
        return gaps


@app.get("/api/duplicates")
async def find_duplicates():
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT a.id as id_a, b.id as id_b,
                   a.pergunta_aluno as pergunta_a, b.pergunta_aluno as pergunta_b,
                   cosine_similarity(a.embedding, b.embedding) as similarity
            FROM knowledge_base a, knowledge_base b
            WHERE a.id < b.id
            AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
            AND cosine_similarity(a.embedding, b.embedding) > 0.95
            ORDER BY similarity DESC
            LIMIT 50
        """)
        results = []
        for r in cur.fetchall():
            results.append({
                'id_a': r['id_a'], 'id_b': r['id_b'],
                'pergunta_a': str(r['pergunta_a'])[:150], 'pergunta_b': str(r['pergunta_b'])[:150],
                'similarity': round(float(r['similarity']), 4)
            })
        return results


# --- Routes: Student & Tabulation ---

DCZ_CRM = 'https://crm.g1.datacrazy.io/api/crm'

@app.get("/api/student/{phone}")
async def get_student(phone: str):
    """Busca dados do aluno no DataCrazy CRM + memória local."""
    h = {'Authorization': f'Bearer {DCZ_TOKEN}', 'Content-Type': 'application/json'}
    clean_phone = phone.replace('+', '').replace(' ', '').replace('-', '')

    lead = None
    try:
        r = http_requests.get(f'{DCZ_CRM}/leads', headers=h,
                             params={'search': clean_phone, 'limit': 3}, timeout=10)
        if r.status_code == 200:
            leads = r.json().get('data', [])
            if leads:
                lead = leads[0]
    except Exception:
        pass

    memory = None
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM student_memory WHERE phone LIKE %s", (f'%{clean_phone[-11:]}%',))
        memory = cur.fetchone()
        if memory:
            if memory.get('last_contact_at'):
                memory['last_contact_at'] = memory['last_contact_at'].isoformat()
            if memory.get('first_contact_at'):
                memory['first_contact_at'] = memory['first_contact_at'].isoformat()

    return {
        'lead': {
            'id': lead.get('id', '') if lead else None,
            'name': lead.get('name', '') if lead else None,
            'phone': lead.get('rawPhone', '') if lead else None,
            'cpf': lead.get('taxId', '') if lead else None,
            'email': lead.get('email', '') if lead else None,
            'tags': [t.get('name', '') for t in lead.get('tags', [])] if lead else [],
        } if lead else None,
        'memory': memory,
    }


@app.get("/api/tabulation/stats")
async def tabulation_stats():
    """Estatísticas de tabulação dos atendimentos."""
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        cur.execute("SELECT count(*) as total FROM interaction_summary")
        total = cur.fetchone()['total']

        cur.execute("SELECT tema, count(*) as cnt FROM interaction_summary GROUP BY tema ORDER BY cnt DESC")
        by_tema = [{'tema': r['tema'], 'count': r['cnt']} for r in cur.fetchall()]

        cur.execute("SELECT sentimento, count(*) as cnt FROM interaction_summary GROUP BY sentimento ORDER BY cnt DESC")
        by_sentiment = [{'sentimento': r['sentimento'], 'count': r['cnt']} for r in cur.fetchall()]

        cur.execute("SELECT resolvido, count(*) as cnt FROM interaction_summary GROUP BY resolvido ORDER BY cnt DESC")
        by_resolved = [{'resolvido': r['resolvido'], 'count': r['cnt']} for r in cur.fetchall()]

        cur.execute("SELECT avg(nps_implicito) as avg_nps FROM interaction_summary WHERE nps_implicito IS NOT NULL")
        avg_nps = cur.fetchone()['avg_nps'] or 0

        cur.execute("""
            SELECT phone, student_name, count(*) as cnt, avg(nps_implicito) as avg_nps
            FROM interaction_summary WHERE student_name IS NOT NULL
            GROUP BY phone, student_name ORDER BY cnt DESC LIMIT 10
        """)
        top_students = [{'phone': r['phone'], 'name': r['student_name'], 'count': r['cnt'],
                        'avg_nps': round(float(r['avg_nps']), 1) if r['avg_nps'] else 0} for r in cur.fetchall()]

        cur.execute("""
            SELECT * FROM interaction_summary ORDER BY created_at DESC LIMIT 20
        """)
        recent = []
        for r in cur.fetchall():
            item = dict(r)
            if item.get('created_at'):
                item['created_at'] = item['created_at'].isoformat()
            recent.append(item)

        return {
            'total': total,
            'by_tema': by_tema,
            'by_sentiment': by_sentiment,
            'by_resolved': by_resolved,
            'avg_nps': round(float(avg_nps), 1),
            'top_students': top_students,
            'recent': recent,
        }


@app.get("/api/memory/list")
async def list_memories(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    """Lista memórias de alunos."""
    offset = (page - 1) * per_page
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT count(*) as cnt FROM student_memory")
        total = cur.fetchone()['cnt']
        cur.execute("SELECT * FROM student_memory ORDER BY last_contact_at DESC LIMIT %s OFFSET %s", (per_page, offset))
        items = cur.fetchall()
        for i in items:
            for k in ('first_contact_at', 'last_contact_at', 'updated_at'):
                if i.get(k):
                    i[k] = i[k].isoformat()
        return {'items': items, 'total': total, 'page': page, 'pages': (total + per_page - 1) // per_page}


# ===================== BLOCO A: GESTÃO DE CONTEÚDO =====================

@app.get("/api/export/csv")
async def export_csv():
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['id', 'pergunta_aluno', 'resposta_atendente', 'tema', 'whatsapp_buttons'])
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, pergunta_aluno, resposta_atendente, tema, whatsapp_buttons, media_attachments FROM knowledge_base ORDER BY id")
        for row in cur.fetchall():
            writer.writerow(row)
    content = output.getvalue().encode('utf-8-sig')
    return JSONResponse(content={'csv': output.getvalue()}, headers={
        'Content-Disposition': 'attachment; filename=knowledge_base.csv'
    })


@app.get("/api/export/json")
async def export_json():
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT id, pergunta_aluno, resposta_atendente, tema, whatsapp_buttons, media_attachments FROM knowledge_base ORDER BY id")
        items = cur.fetchall()
    return {'items': items, 'total': len(items)}


class BulkDeleteRequest(BaseModel):
    ids: List[int]

class BulkUpdateTemaRequest(BaseModel):
    ids: List[int]
    tema: str

class MergeRequest(BaseModel):
    keep_id: int
    delete_id: int
    merged_question: Optional[str] = None
    merged_answer: Optional[str] = None


@app.post("/api/qa/bulk-delete")
async def bulk_delete_qa(data: BulkDeleteRequest):
    if not data.ids:
        raise HTTPException(400, "Nenhum ID fornecido")
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM knowledge_base WHERE id = ANY(%s)", (data.ids,))
        deleted = cur.rowcount
        conn.commit()
    return {'deleted': deleted}


@app.post("/api/qa/bulk-update-tema")
async def bulk_update_tema(data: BulkUpdateTemaRequest):
    if not data.ids:
        raise HTTPException(400, "Nenhum ID fornecido")
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE knowledge_base SET tema = %s WHERE id = ANY(%s)", (data.tema, data.ids))
        updated = cur.rowcount
        conn.commit()
    return {'updated': updated}


@app.post("/api/qa/regenerate-embeddings")
async def regenerate_embeddings():
    client = OpenAI(api_key=OPENAI_API_KEY)
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, pergunta_aluno FROM knowledge_base")
        rows = cur.fetchall()
        count = 0
        for rid, pergunta in rows:
            try:
                emb = client.embeddings.create(input=pergunta[:2000], model='text-embedding-3-small', dimensions=256).data[0].embedding
                emb_str = ','.join(str(x) for x in emb)
                cur.execute(f"UPDATE knowledge_base SET embedding = ARRAY[{emb_str}]::float8[] WHERE id = %s", (rid,))
                count += 1
            except Exception:
                pass
        conn.commit()
    return {'regenerated': count, 'total': len(rows)}


@app.post("/api/qa/merge")
async def merge_qa(data: MergeRequest):
    client = OpenAI(api_key=OPENAI_API_KEY)
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM knowledge_base WHERE id = %s", (data.keep_id,))
        keep = cur.fetchone()
        cur.execute("SELECT * FROM knowledge_base WHERE id = %s", (data.delete_id,))
        delete_row = cur.fetchone()
        if not keep or not delete_row:
            raise HTTPException(404, "Q&A não encontrado")

        merged_q = data.merged_question or keep['pergunta_aluno']
        merged_a = data.merged_answer or keep['resposta_atendente']

        emb = client.embeddings.create(input=merged_q[:2000], model='text-embedding-3-small', dimensions=256).data[0].embedding
        emb_str = ','.join(str(x) for x in emb)
        cur.execute(f"UPDATE knowledge_base SET pergunta_aluno=%s, resposta_atendente=%s, embedding=ARRAY[{emb_str}]::float8[] WHERE id=%s",
                    (merged_q, merged_a, data.keep_id))
        cur.execute("DELETE FROM knowledge_base WHERE id = %s", (data.delete_id,))
        conn.commit()
    return {'message': 'Mesclado com sucesso', 'kept_id': data.keep_id}


@app.post("/api/import/csv/preview")
async def preview_csv(file: UploadFile = File(...)):
    content = await file.read()
    text = content.decode('utf-8-sig')
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for i, row in enumerate(reader):
        if i >= 10:
            break
        rows.append(row)
    total_lines = text.count('\n')
    return {'preview': rows, 'total_estimated': total_lines, 'columns': reader.fieldnames or []}


# ===================== BLOCO A: FILTROS =====================

@app.get("/api/analytics/filtered")
async def get_analytics_filtered(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
):
    date_filter = ""
    params = []
    if start_date:
        date_filter += " AND created_at >= %s"
        params.append(start_date)
    if end_date:
        date_filter += " AND created_at <= %s"
        params.append(end_date + ' 23:59:59')

    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        cur.execute(f"SELECT count(*) as total FROM ia_interaction_log WHERE 1=1 {date_filter}", params)
        total = cur.fetchone()['total']

        cur.execute(f"SELECT acao, count(*) as cnt FROM ia_interaction_log WHERE 1=1 {date_filter} GROUP BY acao ORDER BY cnt DESC", params)
        by_action = [dict(r) for r in cur.fetchall()]

        cur.execute(f"SELECT avg(confianca) as avg_conf FROM ia_interaction_log WHERE confianca IS NOT NULL {date_filter}", params)
        avg_conf = cur.fetchone()['avg_conf'] or 0

        cur.execute(f"""SELECT date(created_at) as day, count(*) as cnt, avg(confianca) as avg_conf
            FROM ia_interaction_log WHERE 1=1 {date_filter}
            GROUP BY date(created_at) ORDER BY day DESC LIMIT 30""", params)
        timeline = [{'day': str(r['day']), 'count': r['cnt'], 'avg_conf': round(float(r['avg_conf'] or 0), 2)} for r in cur.fetchall()]

        cur.execute(f"""SELECT avaliacao, count(*) as cnt FROM chat_evaluations WHERE 1=1 {date_filter}
            GROUP BY avaliacao ORDER BY cnt DESC""", params)
        evals = [dict(r) for r in cur.fetchall()]

        return {'total': total, 'by_action': by_action, 'avg_confidence': round(float(avg_conf), 2),
                'timeline': timeline, 'evaluations': evals}


@app.get("/api/interactions/filtered")
async def list_interactions_filtered(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    search: Optional[str] = None,
    acao: Optional[str] = None,
    min_conf: Optional[float] = None,
    max_conf: Optional[float] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
):
    offset = (page - 1) * per_page
    where = ["1=1"]
    params = []
    if search:
        where.append("(pergunta_recebida ILIKE %s OR resposta_gerada ILIKE %s)")
        params.extend([f'%{search}%', f'%{search}%'])
    if acao:
        where.append("acao = %s")
        params.append(acao)
    if min_conf is not None:
        where.append("confianca >= %s")
        params.append(min_conf)
    if max_conf is not None:
        where.append("confianca <= %s")
        params.append(max_conf)
    if start_date:
        where.append("created_at >= %s")
        params.append(start_date)
    if end_date:
        where.append("created_at <= %s")
        params.append(end_date + ' 23:59:59')

    where_sql = " AND ".join(where)
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(f"SELECT count(*) as cnt FROM ia_interaction_log WHERE {where_sql}", params)
        total = cur.fetchone()['cnt']
        cur.execute(f"SELECT * FROM ia_interaction_log WHERE {where_sql} ORDER BY created_at DESC LIMIT %s OFFSET %s",
                    params + [per_page, offset])
        items = cur.fetchall()
        for i in items:
            if i.get('created_at'):
                i['created_at'] = i['created_at'].isoformat()
        return {'items': items, 'total': total, 'page': page, 'pages': (total + per_page - 1) // per_page}


# ===================== BLOCO B: SENTIMENTO =====================

@app.get("/api/sentiment/dashboard")
async def sentiment_dashboard(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
):
    date_filter = ""
    params = []
    if start_date:
        date_filter += " AND created_at >= %s"
        params.append(start_date)
    if end_date:
        date_filter += " AND created_at <= %s"
        params.append(end_date + ' 23:59:59')

    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        cur.execute(f"SELECT count(*) as total FROM interaction_summary WHERE 1=1 {date_filter}", params)
        total = cur.fetchone()['total']

        cur.execute(f"SELECT count(*) as cnt FROM interaction_summary WHERE sentimento = 'frustrado' {date_filter}", params)
        frustrated = cur.fetchone()['cnt']

        cur.execute(f"SELECT count(*) as cnt FROM interaction_summary WHERE nps_implicito <= 6 {date_filter}", params)
        detractors = cur.fetchone()['cnt']

        cur.execute(f"SELECT count(*) as cnt FROM interaction_summary WHERE nps_implicito >= 9 {date_filter}", params)
        promoters = cur.fetchone()['cnt']

        cur.execute(f"SELECT avg(nps_implicito) as avg_nps FROM interaction_summary WHERE nps_implicito IS NOT NULL {date_filter}", params)
        avg_nps = cur.fetchone()['avg_nps'] or 0

        cur.execute(f"SELECT count(*) as cnt FROM interaction_summary WHERE resolvido = 'sim' {date_filter}", params)
        resolved = cur.fetchone()['cnt']

        cur.execute(f"""SELECT date(created_at) as day, sentimento, count(*) as cnt
            FROM interaction_summary WHERE sentimento IS NOT NULL {date_filter}
            GROUP BY date(created_at), sentimento ORDER BY day""", params)
        sentiment_timeline = []
        for r in cur.fetchall():
            sentiment_timeline.append({'day': str(r['day']), 'sentimento': r['sentimento'], 'count': r['cnt']})

        cur.execute(f"""SELECT
            CASE WHEN nps_implicito <= 6 THEN 'detrator'
                 WHEN nps_implicito <= 8 THEN 'neutro'
                 ELSE 'promotor' END as grupo,
            count(*) as cnt
            FROM interaction_summary WHERE nps_implicito IS NOT NULL {date_filter}
            GROUP BY grupo ORDER BY grupo""", params)
        nps_distribution = [dict(r) for r in cur.fetchall()]

        cur.execute(f"""SELECT tema, count(*) as cnt
            FROM interaction_summary WHERE sentimento = 'frustrado' {date_filter}
            GROUP BY tema ORDER BY cnt DESC LIMIT 10""", params)
        frustrated_topics = [dict(r) for r in cur.fetchall()]

        cur.execute(f"""SELECT phone, student_name, count(*) as cnt, avg(nps_implicito) as avg_nps
            FROM interaction_summary
            WHERE (sentimento = 'frustrado' OR nps_implicito <= 6) {date_filter}
            GROUP BY phone, student_name HAVING count(*) >= 2
            ORDER BY cnt DESC LIMIT 20""", params)
        repeat_detractors = []
        for r in cur.fetchall():
            repeat_detractors.append({
                'phone': r['phone'], 'name': r['student_name'],
                'count': r['cnt'], 'avg_nps': round(float(r['avg_nps'] or 0), 1)
            })

        cur.execute(f"""SELECT * FROM interaction_summary
            WHERE (sentimento = 'frustrado' OR nps_implicito <= 6) {date_filter}
            ORDER BY created_at DESC LIMIT 20""", params)
        recent_alerts = []
        for r in cur.fetchall():
            item = dict(r)
            if item.get('created_at'):
                item['created_at'] = item['created_at'].isoformat()
            recent_alerts.append(item)

        resolution_rate = round(resolved / total * 100, 1) if total > 0 else 0

        return {
            'total': total,
            'frustrated': frustrated,
            'detractors': detractors,
            'promoters': promoters,
            'avg_nps': round(float(avg_nps), 1),
            'resolution_rate': resolution_rate,
            'sentiment_timeline': sentiment_timeline,
            'nps_distribution': nps_distribution,
            'frustrated_topics': frustrated_topics,
            'repeat_detractors': repeat_detractors,
            'recent_alerts': recent_alerts,
        }


# ===================== BLOCO C: EQUIPE (SUPABASE) =====================

SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')
SUPABASE_HEADERS = {'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'}
SUPABASE_TABLE = 'distribuicao_academico_duplicate'


def supabase_get(endpoint, params=None):
    r = http_requests.get(f'{SUPABASE_URL}/rest/v1/{endpoint}', headers=SUPABASE_HEADERS, params=params or {}, timeout=10)
    return r.json() if r.status_code == 200 else []


@app.get("/api/agents/status")
async def agents_status():
    from datetime import datetime
    agents = supabase_get(SUPABASE_TABLE, {'select': '*', 'order': 'responsavel'})
    now = datetime.now().strftime('%H:%M:%S')
    result = []
    for a in agents:
        almoco = a.get('almoco', '12:00:00')
        almoco_fim = a.get('almoco_real', '13:00:00')
        fim_exp = a.get('final_expediente', '18:00:00')
        status = 'inativo'
        if a.get('ativo_inativo') == 'Ativo':
            if almoco and almoco_fim and almoco <= now <= almoco_fim:
                status = 'almoco'
            elif fim_exp and now > fim_exp:
                status = 'encerrado'
            elif fim_exp and now >= fim_exp.replace(fim_exp[-2:], str(max(0, int(fim_exp[-5:-3]) - 0)).zfill(2)):
                mins_left = 0
                try:
                    from datetime import datetime as dt
                    t_now = dt.strptime(now, '%H:%M:%S')
                    t_end = dt.strptime(fim_exp, '%H:%M:%S')
                    mins_left = (t_end - t_now).total_seconds() / 60
                except Exception:
                    pass
                if mins_left <= 15 and mins_left > 0:
                    status = 'encerrando'
                else:
                    status = 'ativo'
            else:
                status = 'ativo'
        result.append({
            'nome': a.get('responsavel', ''),
            'status': status,
            'ativo_inativo': a.get('ativo_inativo', ''),
            'almoco': almoco,
            'almoco_real': almoco_fim,
            'final_expediente': fim_exp,
            'fila': a.get('fila', 0),
            'tipo_atendimento': a.get('tipo_atendimento', ''),
            'pausa_distribuicao': a.get('pausa_distribuicao', 0),
            'volume_distribuicao': a.get('volume_distribuicao', 0),
            'status_final': a.get('status_final', ''),
            'status_almoco': a.get('status_almoco', ''),
            'ultima_execucao': a.get('ultima_execucao', ''),
        })
    return {'agents': result, 'server_time': now}


# ===================== BLOCO D: ALUNOS =====================

@app.delete("/api/memory/{phone}")
async def delete_memory(phone: str):
    clean = phone.replace('+', '').replace(' ', '').replace('-', '')[-11:]
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM student_memory WHERE phone LIKE %s", (f'%{clean}%',))
        deleted = cur.rowcount
        conn.commit()
    return {'deleted': deleted}


@app.get("/api/memory/search")
async def search_memories(q: str = Query(..., min_length=2)):
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM student_memory WHERE student_name ILIKE %s OR phone LIKE %s ORDER BY last_contact_at DESC LIMIT 20",
                    (f'%{q}%', f'%{q}%'))
        items = cur.fetchall()
        for i in items:
            for k in ('first_contact_at', 'last_contact_at', 'updated_at'):
                if i.get(k):
                    i[k] = i[k].isoformat()
        return {'items': items}


@app.get("/api/memory/{phone}/interactions")
async def memory_interactions(phone: str):
    clean = phone.replace('+', '').replace(' ', '').replace('-', '')[-11:]
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM interaction_summary WHERE phone LIKE %s ORDER BY created_at DESC LIMIT 50",
                    (f'%{clean}%',))
        items = cur.fetchall()
        for i in items:
            if i.get('created_at'):
                i['created_at'] = i['created_at'].isoformat()
        return {'items': items}


# ===================== WEBHOOK PROXY META (Typing Indicator) =====================

import httpx
from collections import OrderedDict

N8N_WEBHOOK_URL = 'https://n8n-new-n8n.ca31ey.easypanel.host/webhook/583eb17d-3455-4d64-ab68-67996fdb30af/webhook'
CALL_HANDLER_WEBHOOK_URL = os.environ.get('CALL_HANDLER_WEBHOOK_URL', 'https://banco-whats-calling.6tqx2r.easypanel.host/webhook/calls')
META_VERIFY_TOKEN = os.environ.get('META_VERIFY_TOKEN', 'tokenmetaacad2026')

_wamid_cache = OrderedDict()
_WAMID_CACHE_MAX = 500


def _store_wamid(phone: str, wamid: str):
    _wamid_cache[phone] = {'wamid': wamid, 'ts': time.time()}
    if len(_wamid_cache) > _WAMID_CACHE_MAX:
        _wamid_cache.popitem(last=False)


def _extract_wamids(payload: dict):
    """Extrai phone->wamid de um payload de webhook da Meta."""
    try:
        for entry in payload.get('entry', []):
            for change in entry.get('changes', []):
                value = change.get('value', {})
                for msg in value.get('messages', []):
                    wamid = msg.get('id', '')
                    phone = msg.get('from', '')
                    if wamid and phone:
                        _store_wamid(phone, wamid)
    except Exception:
        pass


@app.get("/webhook/meta")
async def meta_webhook_verify(request: Request):
    """Verificação do webhook (challenge) — Meta envia GET na configuração."""
    params = dict(request.query_params)
    mode = params.get('hub.mode', '')
    token = params.get('hub.verify_token', '')
    challenge = params.get('hub.challenge', '')

    if mode == 'subscribe' and token == META_VERIFY_TOKEN:
        return JSONResponse(content=int(challenge), status_code=200)

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(N8N_WEBHOOK_URL, params=params)
        return JSONResponse(content=r.text, status_code=r.status_code)


def _has_calls_event(payload: dict) -> bool:
    """Verifica se o payload contém eventos de chamada."""
    try:
        for entry in payload.get('entry', []):
            for change in entry.get('changes', []):
                if change.get('field') == 'calls':
                    return True
    except Exception:
        pass
    return False


@app.post("/webhook/meta")
async def meta_webhook_receive(request: Request):
    """Recebe webhook da Meta, roteia calls para call_handler e messages para n8n."""
    body = await request.body()
    try:
        payload = json.loads(body)
    except Exception:
        payload = {}

    if _has_calls_event(payload):
        print(f"[WEBHOOK PROXY] Evento de CHAMADA detectado, encaminhando para call_handler", flush=True)
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                await client.post(
                    CALL_HANDLER_WEBHOOK_URL,
                    content=body,
                    headers={'Content-Type': 'application/json'}
                )
        except Exception as e:
            print(f"[WEBHOOK PROXY] Erro ao encaminhar chamada: {e}", flush=True)
        return JSONResponse(content={"status": "ok"}, status_code=200)

    _extract_wamids(payload)

    for phone, entry in _wamid_cache.items():
        try:
            with get_db() as conn:
                cur = conn.cursor()
                cur.execute(
                    "INSERT INTO wamid_cache (phone, wamid, updated_at) VALUES (%s, %s, NOW()) ON CONFLICT (phone) DO UPDATE SET wamid = EXCLUDED.wamid, updated_at = NOW()",
                    (phone, entry['wamid'])
                )
                conn.commit()
        except Exception:
            pass

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            await client.post(
                N8N_WEBHOOK_URL,
                content=body,
                headers={'Content-Type': 'application/json'}
            )
    except Exception as e:
        print(f"[WEBHOOK PROXY] Erro ao repassar para n8n: {e}")

    return JSONResponse(content={"status": "ok"}, status_code=200)


@app.get("/api/wamid/{phone}")
async def get_wamid(phone: str):
    """Retorna o último wamid — tenta cache em memória, depois PostgreSQL."""
    clean = phone.replace('+', '').replace(' ', '').replace('-', '')

    entry = _wamid_cache.get(clean)
    if entry:
        return {'wamid': entry['wamid'], 'age_seconds': time.time() - entry['ts'], 'source': 'memory'}
    for key, val in reversed(_wamid_cache.items()):
        if key.endswith(clean[-11:]):
            return {'wamid': val['wamid'], 'age_seconds': time.time() - val['ts'], 'source': 'memory'}

    try:
        with get_db() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT wamid, EXTRACT(EPOCH FROM (NOW() - updated_at)) as age FROM wamid_cache WHERE phone LIKE %s ORDER BY updated_at DESC LIMIT 1",
                (f'%{clean[-11:]}%',)
            )
            row = cur.fetchone()
            if row and row[1] < 300:
                _store_wamid(clean, row[0])
                return {'wamid': row[0], 'age_seconds': row[1], 'source': 'postgres'}
    except Exception:
        pass

    return {'wamid': None}


class WamidStoreRequest(BaseModel):
    phone: str
    wamid: str


@app.post("/api/wamid/store")
async def store_wamid_endpoint(req: WamidStoreRequest):
    """Recebe wamid do n8n e armazena em memória + PostgreSQL."""
    clean = req.phone.replace('+', '').replace(' ', '').replace('-', '')
    _store_wamid(clean, req.wamid)
    try:
        with get_db() as conn:
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO wamid_cache (phone, wamid, updated_at) VALUES (%s, %s, NOW()) ON CONFLICT (phone) DO UPDATE SET wamid = EXCLUDED.wamid, updated_at = NOW()",
                (clean, req.wamid)
            )
            conn.commit()
    except Exception:
        pass
    return {'stored': True, 'phone': clean, 'wamid': req.wamid[:40]}


# ===================== AGENT CONFIG =====================

AGENT_CONFIG_DEFAULTS = {
    "followup_1_delay": 300,
    "followup_1_msg": "Oi{name}! Ainda está por aí? Se tiver mais alguma dúvida, é só falar 😊",
    "followup_1_buttons": ["Tenho outra dúvida", "Não, obrigado!"],
    "close_delay": 600,
    "close_msg": "Como não tivemos retorno, vou finalizar o contato por aqui para te deixar seguir com seus compromissos. Estaremos à disposição caso precise retomar o assunto depois! ✨",
    "close_buttons": [],
    "poll_interval": 3,
    "confidence_threshold": 0.5,
    "response_cooldown": 2.0,
    "greeting_returning": "Olá, *{fname}*! Que bom falar com você novamente 😊\n\nNa última vez que conversamos, você estava com algumas dúvidas sobre *{topic}* — espero que tenha conseguido te ajudar naquele momento.\n\nAgora me conta: como posso te ajudar hoje?\n\nEscolha uma opção abaixo para agilizar seu atendimento 👇",
    "greeting_returning_no_topic": "Olá, *{fname}*! Que bom falar com você novamente 😊\n\nNa última vez que conversamos, você estava com algumas dúvidas — espero que tenha conseguido te ajudar naquele momento.\n\nAgora me conta: como posso te ajudar hoje?\n\nEscolha uma opção abaixo para agilizar seu atendimento 👇",
    "greeting_new": "Olá, *{fname}*! Bem-vindo(a) ao Suporte da *Cruzeiro do Sul* 😊\n\nComo posso te ajudar?\n\nEscolha uma opção abaixo para agilizar seu atendimento 👇",
    "greeting_anonymous": "Olá! Bem-vindo ao Suporte ao Aluno da *Cruzeiro do Sul* 😊\n\nComo posso te ajudar?\n\nEscolha uma opção abaixo para agilizar seu atendimento 👇",
    "greeting_buttons": ["Acesso Portal/App", "Financeiro", "Aulas e Conteúdo", "Documentos", "Rematrícula", "Falar com atendente"],
}


def ensure_agent_config_table():
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS agent_config (
                key VARCHAR(100) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        """)
        conn.commit()
        cur.close()
        conn.close()
    except Exception:
        pass

ensure_agent_config_table()


@app.get("/api/agent-config")
async def get_agent_config():
    """Retorna todas as configs do agente (DB + defaults)."""
    config = dict(AGENT_CONFIG_DEFAULTS)
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cur = conn.cursor()
        cur.execute("SELECT key, value FROM agent_config")
        for key, value in cur.fetchall():
            try:
                config[key] = json.loads(value)
            except (json.JSONDecodeError, TypeError):
                config[key] = value
        cur.close()
        conn.close()
    except Exception:
        pass
    return config


@app.post("/api/agent-config")
async def save_agent_config(request: Request):
    """Salva configs do agente no banco."""
    data = await request.json()
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cur = conn.cursor()
        for key, value in data.items():
            if key not in AGENT_CONFIG_DEFAULTS:
                continue
            val_str = json.dumps(value) if isinstance(value, (list, dict)) else json.dumps(value)
            cur.execute("""
                INSERT INTO agent_config (key, value, updated_at)
                VALUES (%s, %s, NOW())
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            """, (key, val_str))
        conn.commit()
        cur.close()
        conn.close()
        return {"saved": True, "keys": list(data.keys())}
    except Exception as e:
        return {"saved": False, "error": str(e)}


# ===================== MENUS CRUD =====================

def _build_menu_tree(rows):
    """Constrói árvore aninhada a partir de lista flat de rows."""
    nodes = {}
    for r in rows:
        nodes[r['id']] = {**r, 'children': []}
    roots = []
    for n in nodes.values():
        pid = n.get('parent_id')
        if pid and pid in nodes:
            nodes[pid]['children'].append(n)
        elif not pid:
            roots.append(n)
    return roots


@app.get("/api/menus")
async def get_menus():
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT id, parent_id, level, menu_key, label, response_text, rag_question, sort_order, active FROM agent_menus ORDER BY sort_order, id")
        rows = cur.fetchall()
    return {"tree": _build_menu_tree(rows), "flat": rows}


@app.post("/api/menus")
async def create_menu(request: Request):
    data = await request.json()
    label = data.get('label', '').strip()
    if not label:
        raise HTTPException(400, "Label obrigatório")
    menu_key = data.get('menu_key', label.lower()).strip().lower().replace('*', '')
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO agent_menus (parent_id, level, menu_key, label, response_text, rag_question, sort_order, active) VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
            (data.get('parent_id'), data.get('level', 'leaf'), menu_key, label,
             data.get('response_text'), data.get('rag_question'),
             data.get('sort_order', 0), data.get('active', True)))
        new_id = cur.fetchone()[0]
        conn.commit()
    return {"id": new_id, "created": True}


@app.put("/api/menus/{menu_id}")
async def update_menu(menu_id: int, request: Request):
    data = await request.json()
    updates, params = [], []
    for field in ('label', 'menu_key', 'response_text', 'rag_question', 'sort_order', 'active', 'level', 'parent_id'):
        if field in data:
            updates.append(f"{field} = %s")
            val = data[field]
            if field == 'menu_key' and isinstance(val, str):
                val = val.strip().lower()
            params.append(val)
    if not updates:
        raise HTTPException(400, "Nenhum campo para atualizar")
    updates.append("updated_at = NOW()")
    params.append(menu_id)
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE agent_menus SET {', '.join(updates)} WHERE id = %s", params)
        if cur.rowcount == 0:
            raise HTTPException(404)
        conn.commit()
    return {"updated": True}


@app.delete("/api/menus/{menu_id}")
async def delete_menu(menu_id: int):
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM agent_menus WHERE id = %s", (menu_id,))
        if cur.rowcount == 0:
            raise HTTPException(404)
        conn.commit()
    return {"deleted": True}


@app.post("/api/menus/reorder")
async def reorder_menus(request: Request):
    data = await request.json()
    items = data.get('items', [])
    with get_db() as conn:
        cur = conn.cursor()
        for item in items:
            cur.execute("UPDATE agent_menus SET sort_order = %s, parent_id = %s, updated_at = NOW() WHERE id = %s",
                       (item['sort_order'], item.get('parent_id'), item['id']))
        conn.commit()
    return {"reordered": len(items)}


@app.post("/api/menus/seed")
async def seed_menus():
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM agent_menus")
        _seed_default_menus(cur)
        conn.commit()
    return {"seeded": True}


@app.post("/api/agent/reload")
async def agent_reload():
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO agent_config (key, value, updated_at)
            VALUES ('_reload_flag', %s, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        """, (str(time.time()),))
        conn.commit()
    return {"reload_requested": True}


@app.post("/api/agent/restart")
async def agent_restart():
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO agent_config (key, value, updated_at)
            VALUES ('_restart_flag', %s, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        """, (str(time.time()),))
        conn.commit()
    return {"restart_requested": True}


@app.post("/api/media/upload")
async def upload_media(file: UploadFile = File(...)):
    if file.content_type not in ALLOWED_MEDIA_TYPES:
        raise HTTPException(400, f"Tipo não suportado: {file.content_type}. Permitidos: imagens, vídeos, PDF")
    content = await file.read()
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(400, f"Arquivo muito grande ({len(content)//1024//1024}MB). Máximo: 16MB")
    ext = os.path.splitext(file.filename or '')[1] or '.bin'
    safe_name = f"{int(time.time())}_{secrets.token_hex(6)}{ext}"
    filepath = os.path.join(MEDIA_DIR, safe_name)
    with open(filepath, 'wb') as f:
        f.write(content)
    media_type = 'image' if file.content_type.startswith('image') else 'video' if file.content_type.startswith('video') else 'document'
    return {
        "url": f"/media/{safe_name}",
        "filename": file.filename,
        "type": media_type,
        "mimeType": file.content_type,
        "size": len(content)
    }


ALERT_CATEGORIES = ['geral', 'instabilidade', 'manutencao', 'aviso', 'evento', 'urgente']


@app.get("/api/alerts")
async def list_alerts(active_only: bool = False):
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        if active_only:
            cur.execute("""SELECT * FROM agent_alerts
                           WHERE active = TRUE AND (starts_at IS NULL OR starts_at <= NOW())
                           AND (expires_at IS NULL OR expires_at > NOW())
                           ORDER BY priority DESC, created_at DESC""")
        else:
            cur.execute("SELECT * FROM agent_alerts ORDER BY active DESC, priority DESC, created_at DESC")
        rows = cur.fetchall()
        for r in rows:
            for k in ('starts_at', 'expires_at', 'created_at'):
                if r.get(k):
                    r[k] = r[k].isoformat()
        return {"items": rows, "categories": ALERT_CATEGORIES}


@app.post("/api/alerts")
async def create_alert(request: Request):
    data = await request.json()
    title = data.get('title', '').strip()
    message = data.get('message', '').strip()
    if not title or not message:
        raise HTTPException(400, "title e message são obrigatórios")
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("""INSERT INTO agent_alerts (title, message, category, active, priority, starts_at, expires_at, display_mode)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                    (title, message,
                     data.get('category', 'geral'),
                     data.get('active', True),
                     data.get('priority', 0),
                     data.get('starts_at') or None,
                     data.get('expires_at') or None,
                     data.get('display_mode', 'context')))
        new_id = cur.fetchone()[0]
        conn.commit()
        return {"id": new_id, "created": True}


@app.put("/api/alerts/{alert_id}")
async def update_alert(alert_id: int, request: Request):
    data = await request.json()
    with get_db() as conn:
        cur = conn.cursor()
        fields = []
        vals = []
        for col in ('title', 'message', 'category', 'active', 'priority', 'starts_at', 'expires_at', 'display_mode'):
            if col in data:
                fields.append(f"{col} = %s")
                v = data[col]
                if col in ('starts_at', 'expires_at') and v == '':
                    v = None
                vals.append(v)
        if not fields:
            raise HTTPException(400, "Nenhum campo para atualizar")
        vals.append(alert_id)
        cur.execute(f"UPDATE agent_alerts SET {', '.join(fields)} WHERE id = %s", vals)
        conn.commit()
        return {"updated": cur.rowcount > 0}


@app.delete("/api/alerts/{alert_id}")
async def delete_alert(alert_id: int):
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM agent_alerts WHERE id = %s", (alert_id,))
        conn.commit()
        return {"deleted": cur.rowcount > 0}


if __name__ == '__main__':
    import uvicorn
    print("Cockpit IA rodando em http://localhost:8000")
    uvicorn.run(app, host='0.0.0.0', port=8000)
