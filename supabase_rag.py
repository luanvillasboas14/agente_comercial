"""
Supabase Vector Search - Helper para buscas vetoriais via RPC.
Tabelas: documents, documents_precos, documents_pos, documents_perguntas
Funções: match_documents, match_documents_precos, match_documents_pos, match_documents_perguntas
Embedding model: text-embedding-3-small (1536 dims)
"""
import os
import time
import httpx
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY', '')

_headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
}


def generate_embedding(text: str) -> list[float]:
    client = OpenAI(api_key=OPENAI_API_KEY)
    resp = client.embeddings.create(
        input=text[:2000],
        model='text-embedding-3-small',
    )
    return resp.data[0].embedding


def _rpc_match(fn_name: str, query: str, match_count: int = 5) -> list[dict]:
    """Chama uma função match_* no Supabase via RPC."""
    t0 = time.time()
    embedding = generate_embedding(query)
    t_emb = time.time() - t0

    t1 = time.time()
    r = httpx.post(
        f'{SUPABASE_URL}/rest/v1/rpc/{fn_name}',
        headers=_headers,
        json={
            'query_embedding': embedding,
            'match_count': match_count,
            'filter': {},
        },
        timeout=15,
    )
    t_rpc = time.time() - t1

    if r.status_code != 200:
        print(f'[RAG] {fn_name} ERRO: {r.status_code} {r.text[:200]}', flush=True)
        return []

    results = r.json()
    if results:
        top = results[0].get('similarity', 0)
        print(f'[RAG] {fn_name}: {len(results)} resultados | emb={t_emb*1000:.0f}ms rpc={t_rpc*1000:.0f}ms | top={top:.3f}', flush=True)
    return results


def buscar_precos(query: str, top_k: int = 5) -> list[dict]:
    return _rpc_match('match_documents_precos', query, top_k)


def buscar_informacoes(query: str, top_k: int = 15) -> list[dict]:
    return _rpc_match('match_documents', query, top_k)


def buscar_pos(query: str, top_k: int = 8) -> list[dict]:
    return _rpc_match('match_documents_pos', query, top_k)


def buscar_perguntas(query: str, top_k: int = 6) -> list[dict]:
    return _rpc_match('match_documents_perguntas', query, top_k)


def format_results(results: list[dict], max_chars: int = 3000) -> str:
    """Formata resultados do Supabase para injeção no prompt."""
    if not results:
        return 'Nenhum resultado encontrado.'
    lines = []
    total = 0
    for i, r in enumerate(results):
        content = r.get('content', '')
        sim = r.get('similarity', 0)
        entry = f'--- Resultado {i+1} (sim: {sim:.2f}) ---\n{content}\n'
        if total + len(entry) > max_chars:
            break
        lines.append(entry)
        total += len(entry)
    return '\n'.join(lines)
