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
        'Busca preços e valores de cursos. SEMPRE passe o parâmetro `nivel` quando souber pelo contexto da conversa se o lead quer graduação ou pós — assim a tool já filtra e você não recebe resultados do nível errado.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome limpo do curso (ex: "Administração").' },
          nivel: {
            type: 'string',
            enum: ['graduacao', 'pos'],
            description: 'Nível do curso. Use "graduacao" pra cursos de graduação (bacharelado, licenciatura, tecnólogo). Use "pos" pra pós-graduação, MBA ou especialização. OMITA APENAS se o contexto for genuinamente ambíguo — quando souber pelo histórico da conversa, passe sempre.',
          },
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
        'Dispara o fluxo de inscrição: move o lead para "Aguardando Inscrição" no Kommo e preenche os campos de curso, tipo de ingresso, nível, nome e polo. Use quando o lead confirmar que quer se inscrever em um curso específico, depois de já ter o nome completo do curso (NUNCA chame com curso vago como "as", "ola" ou abreviações). O `telefone` do lead já está no Contexto do atendimento — sempre passe ele. O `id_lead` é OPCIONAL: se não souber, OMITA o campo (a tool resolve pelo telefone). Não envie 0.',
      parameters: {
        type: 'object',
        properties: {
          curso: {
            type: 'string',
            description: 'Nome completo do curso confirmado pelo lead (ex.: "Desenvolvimento Backend").',
          },
          tipo_ingresso: { type: 'string', enum: ['ENEM', 'Vestibular Múltipla Escolha'] },
          telefone: { type: 'string', description: 'Telefone do lead (Contexto do atendimento).' },
          id_lead: {
            type: 'integer',
            description: 'OPCIONAL — id_lead do Kommo se já estiver no Contexto. OMITA se não souber.',
          },
        },
        required: ['curso', 'tipo_ingresso', 'telefone'],
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
        'Encaminha o lead para consultor humano. Use quando o cliente PEDIR para falar com atendente/consultor/humano, ' +
        'ou quando a conversa indicar que ele precisa de ajuda especializada (negociação, casos complexos, fora do escopo da IA). ' +
        'O sistema localiza o lead pelo telefone automaticamente — você NÃO precisa passar id_lead se não souber.',
      parameters: {
        type: 'object',
        properties: {
          telefone: {
            type: 'string',
            description: 'Telefone/WhatsApp do lead (obrigatório). Pode ser só dígitos ou com +55.',
          },
          id_lead: {
            type: 'integer',
            description: 'ID do lead no Kommo. OPCIONAL — se você não souber, omita este campo (NÃO mande 0 nem inventado).',
          },
        },
        required: ['telefone'],
      },
    },
  },
]
