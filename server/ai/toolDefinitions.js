/**
 * Schemas das tools (OpenAI function-calling) — espelha src/lib/supabaseSearch.js.
 * Mantenha em sincronia com o front ao alterar argumentos/descrições.
 */

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'buscar_precos',
      description:
        'Busca preços e valores de cursos na base vetorial do Supabase. Use quando precisar de mensalidades, valores e preços.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome limpo do curso (ex: "Administração").' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_informacoes',
      description:
        'Busca informações de cursos de GRADUAÇÃO (grade, duração, modalidades, áreas). NÃO use para pós-graduação.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome limpo do curso de graduação.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_pos',
      description:
        'Busca informações de PÓS-GRADUAÇÃO, MBA e especializações. SOMENTE quando o usuário mencionar pós/MBA/especialização.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome limpo do curso de pós-graduação.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_perguntas',
      description:
        'Busca respostas para perguntas frequentes (FAQ): matrícula, documentos, funcionamento, bolsas, processos, etc.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Pergunta do usuário.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'localizacao',
      description:
        'Encontra o polo mais próximo do endereço do lead. Use quando houver CEP, cidade, bairro, rua/número.',
      parameters: {
        type: 'object',
        properties: {
          localizacao: { type: 'string', description: 'Cidade, rua e número ou CEP.' },
          telefone: { type: 'string', description: 'Telefone do lead (opcional).' },
        },
        required: ['localizacao'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inscricao',
      description:
        'Dispara o fluxo de inscrição (Kommo/Supabase) com curso e tipo de ingresso. Use quando o lead confirmar inscrição.',
      parameters: {
        type: 'object',
        properties: {
          curso: { type: 'string' },
          tipo_ingresso: { type: 'string', enum: ['ENEM', 'Vestibular Múltipla Escolha'] },
          telefone: { type: 'string' },
          id_lead: { type: 'integer' },
        },
        required: ['curso', 'tipo_ingresso'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_historico_conversa',
      description:
        'Recupera histórico recente de conversa com o lead no WhatsApp (n8n_chat_histories). ' +
        'Use apenas se precisar de mais contexto além das últimas mensagens já injetadas.',
      parameters: {
        type: 'object',
        properties: {
          telefone: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['telefone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'distribuir_humano',
      description:
        'Encaminha o lead para consultor humano. SÓ USAR quando o contexto/RAG indicar ou não houver dados de curso para vender.',
      parameters: {
        type: 'object',
        properties: {
          id_lead: { type: 'integer' },
          telefone: { type: 'string' },
        },
        required: ['id_lead', 'telefone'],
      },
    },
  },
]
