# Cockpit IA - Setup e Deploy

## Pré-requisitos

- Python 3.10+
- PostgreSQL com acesso à base `log_conversa`
- Chave OpenAI API
- Token DataCrazy (para sync de templates)

## Instalação

```bash
pip install fastapi uvicorn psycopg2-binary openai python-multipart requests
```

## Variáveis de Ambiente

| Variável | Default | Descrição |
|----------|---------|-----------|
| `OPENAI_API_KEY` | *(obrigatório)* | Chave API OpenAI |
| `DB_HOST` | `31.97.91.47` | Host PostgreSQL |
| `DB_PORT` | `5432` | Porta PostgreSQL |
| `DB_USER` | `adm_eduit` | Usuário PostgreSQL |
| `DB_PASSWORD` | `IaDm24Sx3HxrYoqT` | Senha PostgreSQL |
| `DB_NAME` | `log_conversa` | Nome do banco |
| `DCZ_TOKEN` | *(padrão interno)* | Token DataCrazy |
| `AUTH_ENABLED` | `false` | Habilitar autenticação |
| `ADMIN_USER` | `admin` | Usuário admin (quando auth habilitado) |
| `ADMIN_PASS` | `eduit2026` | Senha admin (quando auth habilitado) |

## Executar

```bash
export OPENAI_API_KEY="sk-..."
python kb_api.py
```

Acesse: http://localhost:8000

## Ativar Autenticação

```bash
export AUTH_ENABLED=true
export ADMIN_USER=meuuser
export ADMIN_PASS=minhasenha
```

## Tabelas Criadas Automaticamente

Na primeira execução, o sistema cria:

- **prompt_versions**: Versionamento de system prompts com configurações de modelo
- **chat_evaluations**: Registro de avaliações do treinamento (aprovadas/corrigidas/rejeitadas)

## Funcionalidades

### Dashboard
- Métricas gerais da base de conhecimento
- Gráficos de distribuição por tema, ações da IA e avaliações
- Top escalações e custo estimado

### Base Q&A
- CRUD completo com geração automática de embeddings
- Busca, filtro por tema, ordenação

### Chat Treinamento
- Simulador WhatsApp com seleção de modelo e prompt
- Avaliação inline (aprovar/corrigir/rejeitar)
- Painel lateral com referências RAG e campo de correção
- Correções salvas automaticamente na base

### Playground LLM
- Comparação side-by-side (A vs B)
- Editor de prompt customizado ou seleção de prompts salvos
- Sliders de temperatura e max tokens
- Métricas: latência, tokens, custo, confiança

### Gestão de Prompts
- Biblioteca versionada com ativação por clique
- Editor com preview de variáveis {references} e {history}
- Duplicar, ativar, deletar
- Botão "Testar no Playground"

### Enriquecimento
- Upload CSV (drag-and-drop) com colunas: pergunta, resposta, tema
- Sync templates DataCrazy com seleção
- Detector de lacunas (perguntas com baixa confiança)
- Detector de duplicatas (similaridade > 0.95)

### Interações
- Histórico completo das interações do agente ao vivo
- Filtro por ação, confiança, data

## Arquitetura

```
kb_api.py      → Backend FastAPI (PostgreSQL + OpenAI)
kb_admin.html  → Frontend SPA (Tailwind + Chart.js)
```

Ambos os arquivos devem estar no mesmo diretório.
