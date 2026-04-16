# Agente Comercial IA - Guia de Setup

## Visão Geral

Sistema de IA para atendimento comercial via WhatsApp (DataCrazy), usando RAG com Supabase Vector Search + OpenAI Tool-Calling.

**Arquitetura:** WhatsApp -> DataCrazy -> Agente Python (Orquestrador) -> OpenAI GPT-4.1-mini (Tools) -> Supabase (RAG) -> Resposta

---

## Pré-requisitos

- Docker (para deploy via Easypanel)
- Conta OpenAI com API key (GPT-4.1-mini + text-embedding-3-small)
- Acesso ao PostgreSQL (logs e memória)
- Acesso ao Supabase (base vetorial de cursos, preços, FAQ)
- Token da API DataCrazy
- Token da API Meta/WhatsApp

---

## Componentes

### Base de Conhecimento (Supabase)
| Tabela | Função RPC | Conteúdo |
|--------|-----------|----------|
| `documents` | `match_documents` | Informações de cursos (graduação) |
| `documents_precos` | `match_documents_precos` | Preços e mensalidades |
| `documents_pos` | `match_documents_pos` | Pós-graduação/MBA |
| `documents_perguntas` | `match_documents_perguntas` | FAQ (perguntas frequentes) |

### Ferramentas do Orquestrador (Tools)
| Tool | Quando usar |
|------|------------|
| `agente_precos` | Lead pergunta sobre valores/mensalidades |
| `receptivo_informacoes` | Curso mencionado na mensagem |
| `agente_perguntas` | Dúvidas gerais (polos, documentos, bolsas, etc) |
| `distribuir_humano` | Pedido de humano ou confusão |
| `inscricao` | Curso confirmado + tipo de ingresso definido |

---

## Variáveis de Ambiente

```env
OPENAI_API_KEY=sk-proj-...
DCZ_TOKEN=dc_...
META_TOKEN=EAA...
META_PHONE_ID=883452561518366
META_VERIFY_TOKEN=tokenmetaacad2026
DB_HOST=31.97.91.47
DB_PORT=5432
DB_USER=adm_eduit
DB_PASSWORD=...
DB_NAME=log_conversa
SUPABASE_URL=https://fcwuhwedretyomtrbgzb.supabase.co
SUPABASE_KEY=sb_secret_...
ADMIN_USER=admin
ADMIN_PASS=...
AUTH_ENABLED=false
PHONE_TO_MONITOR=11984393285
COCKPIT_BASE_URL=https://seu-dominio.easypanel.host
```

---

## Deploy (Easypanel)

1. Conectar repositório GitHub ao Easypanel
2. Configurar variáveis de ambiente no serviço
3. Ajustar porta do domínio para **8000**
4. Implantar

---

## Arquivos do Projeto

| Arquivo | Descrição |
|---------|-----------|
| `agente_ao_vivo_v4.py` | Agente principal (polling WhatsApp + tool-calling) |
| `kb_api.py` | API do Cockpit (FastAPI) |
| `kb_admin.html` | Painel administrativo |
| `supabase_rag.py` | Helper para buscas vetoriais no Supabase |
| `start.sh` | Script de inicialização do container |
| `Dockerfile` | Build da imagem Docker |

---

## Custos Estimados (mensal)

- **Embeddings**: ~$2-5/mês (text-embedding-3-small)
- **GPT-4.1-mini**: ~$15-30/mês (200 conversas/dia)
- **Total**: ~$20-40/mês
