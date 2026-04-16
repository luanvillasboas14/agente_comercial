# IA de Atendimento ao Aluno - Guia de Setup

## Visao Geral

Sistema de IA para atendimento automatico de alunos via WhatsApp (DataCrazy), usando RAG (Retrieval-Augmented Generation) com historico de 531K+ mensagens de suporte.

**Arquitetura:** DataCrazy (WhatsApp) -> n8n (orquestracao) -> OpenAI (IA) -> PostgreSQL (knowledge base)

---

## Pré-requisitos

- n8n funcionando (acesso ao painel)
- Conta OpenAI com API key (GPT-4o-mini + Embeddings)
- Acesso ao PostgreSQL (31.97.91.47)
- Token da API DataCrazy

---

## O que já foi feito

1. **Analise de dados**: 531K mensagens analisadas, 10.977 conversas
2. **Extracao Q&A**: 9.860 pares pergunta-resposta extraidos
3. **Embeddings**: 9.860 vetores de 256 dimensoes gerados (text-embedding-3-small)
4. **Knowledge Base**: Tabela `knowledge_base` populada com embeddings
5. **Categorizacao**: 800 conversas categorizadas em 16 temas
6. **Funcao de busca**: `cosine_similarity()` criada no PostgreSQL
7. **Tabela de auditoria**: `ia_interaction_log` criada para logs
8. **Workflow n8n**: JSON completo pronto para importar

### Distribuicao de temas identificados:
| Tema | % |
|------|---|
| ACESSO_PORTAL | 19.6% |
| MATRICULA | 14.1% |
| FINANCEIRO_MENSALIDADE | 10.9% |
| ACADEMICO_NOTAS | 7.4% |
| ACESSO_APP | 6.9% |
| ACADEMICO_DISCIPLINAS | 6.4% |
| CERTIFICADO_DIPLOMA | 4.9% |
| AULAS_PRESENCIAIS | 4.5% |
| CANCELAMENTO | 4.0% |
| FINANCEIRO_BOLETO | 3.9% |
| COMERCIAL | 3.8% |
| OUTRO | 7.2% |

---

## Passo a Passo para Deploy

### 1. Testar localmente (recomendado)

```powershell
$env:OPENAI_API_KEY = 'sua-key-aqui'
python testar_rag.py "como acesso o portal do aluno?"
python testar_rag.py "preciso do boleto da mensalidade"
python testar_rag.py "quero cancelar minha matricula"
```

Isso vai mostrar as 5 conversas mais similares encontradas e a resposta que a IA geraria.

### 2. Importar o workflow no n8n

1. Abra o painel do n8n
2. Clique em **"Import from File"**
3. Selecione o arquivo: `ia_atendimento_aluno_workflow.json`
4. O workflow sera importado com 17 nodes

### 3. Configurar credenciais no n8n

Voce precisa criar 2 credenciais:

#### Credencial OpenAI (Header Auth)
- **Nome**: OpenAI API Key
- **Tipo**: Header Auth
- **Header Name**: Authorization
- **Header Value**: Bearer sk-proj-SUA_KEY_AQUI

#### Credencial PostgreSQL
- **Nome**: Postgres Knowledge Base
- **Host**: 31.97.91.47
- **Port**: 5432
- **Database**: log_conversa
- **User**: adm_eduit
- **Password**: IaDm24Sx3HxrYoqT

#### Token DataCrazy
Nos nodes HTTP que chamam a API DataCrazy, substitua `PLACEHOLDER_DATACRAZY_TOKEN` pelo token real da API.

#### WhatsApp Cloud API (envio de mensagens)
O envio de mensagens e feito diretamente pela API do WhatsApp (Meta), nao pela API DataCrazy.
As credenciais ja estao configuradas no workflow:
- **Phone Number ID**: 883452561518366
- **Endpoint**: https://graph.facebook.com/v21.0/883452561518366/messages
- **Token**: Obtido da instancia DataCrazy (CSV_ACADEMICO_OFICIAL)

> **Importante**: Se o token do WhatsApp expirar, atualize no node "Auto Reply" do workflow.

### 4. Configurar placeholders

No workflow, busque e substitua:
- `PLACEHOLDER_ATTENDANT_ID` -> ID do atendente padrao para escalacao

### 5. Deploy em Shadow Mode (recomendado)

O workflow ja vem com `SHADOW_MODE = true` no node "Config". Neste modo:
- A IA processa todas as conversas normalmente
- Gera respostas e calcula confianca
- **NAO envia respostas** automaticamente
- **NAO escalona** para humanos
- Registra tudo na tabela `ia_interaction_log`

Para ativar o modo producao:
1. Abra o node "Config"
2. Mude `SHADOW_MODE` de `true` para `false`
3. Salve e ative o workflow

### 6. Monitorar resultados

Consulte a tabela de auditoria:

```sql
-- Ver ultimas interacoes
SELECT conversation_id, LEFT(pergunta_recebida, 80), 
       confianca, acao, created_at
FROM ia_interaction_log
ORDER BY created_at DESC
LIMIT 20;

-- Distribuicao de acoes
SELECT acao, count(*), avg(confianca)::numeric(3,2)
FROM ia_interaction_log
GROUP BY acao;

-- Respostas de alta confianca (candidatas a auto-reply)
SELECT LEFT(pergunta_recebida, 100), LEFT(resposta_gerada, 200), confianca
FROM ia_interaction_log
WHERE confianca >= 0.8
ORDER BY created_at DESC
LIMIT 10;
```

---

## Arquivos do Projeto

| Arquivo | Descricao |
|---------|-----------|
| `ia_atendimento_aluno_workflow.json` | Workflow n8n completo (importar no n8n) |
| `testar_rag.py` | Script para testar o RAG localmente |
| `analise_log_conversa.py` | Analise exploratoria dos dados |
| `extrair_qa_pairs.py` | Extracao de pares Q&A |
| `categorizar_temas.py` | Categorizacao automatica por tema |
| `gerar_embeddings.py` | Geracao de embeddings OpenAI |
| `setup_knowledge_base.py` | Setup das tabelas e funcoes no PostgreSQL |
| `normalizar_categorias.py` | Normalizacao de categorias com acentos |
| `qa_pairs.json` | 9.860 pares Q&A extraidos |
| `categorias_relatorio.json` | Relatorio de categorizacao |

---

## Custos estimados (mensal)

- **Embeddings**: ~$2-5/mes (queries em tempo real)
- **GPT-4o-mini**: ~$15-30/mes (200 conversas/dia)
- **Total**: ~$20-40/mes

---

## Resultado do Teste ao Vivo (20/mar/2026)

Teste realizado com o numero 5511984393285 (Marcelo):
- **Pergunta**: "Ola, preciso de ajuda para acessar o portal do aluno"
- **RAG Score**: 0.840 (5 conversas similares encontradas)
- **Resposta da IA**: "Oi, tudo bem? Para te ajudar a acessar o portal do aluno, preciso que voce me informe seu CPF..."
- **Confianca**: 0.9
- **Tempo total**: 4.3 segundos
- **Envio**: WhatsApp Cloud API - SUCESSO
- **Mensagem recebida no WhatsApp**: SIM

---

## Proximos passos

1. **Reativar log_conversa**: O workflow de logging parou em fev/2026. Reativar para alimentar continuamente a base
2. **Feedback loop**: Quando atendentes corrigirem respostas da IA, usar isso para melhorar a base
3. **Expandir temas**: Categorizar os 9.060 pares restantes (alem dos 800 ja categorizados)
4. **Instalar pgvector**: Se possivel, instalar a extensao pgvector para buscas mais rapidas
5. **Integrar com distribuicao**: Conectar a escalacao com o workflow de distribuicao de atendentes
