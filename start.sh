#!/bin/bash

echo "=== Iniciando Agente IA + Cockpit API ==="
echo "DB_HOST=${DB_HOST:-NAO DEFINIDO}"
echo "DB_PORT=${DB_PORT:-NAO DEFINIDO}"
echo "DB_USER=${DB_USER:-NAO DEFINIDO}"
echo "DB_NAME=${DB_NAME:-NAO DEFINIDO}"
echo "OPENAI_API_KEY=${OPENAI_API_KEY:+DEFINIDO (${#OPENAI_API_KEY} chars)}"
echo "DCZ_TOKEN=${DCZ_TOKEN:+DEFINIDO (${#DCZ_TOKEN} chars)}"
echo "META_TOKEN=${META_TOKEN:+DEFINIDO (${#META_TOKEN} chars)}"

# Aguardar DB ficar acessivel (ate 30s)
echo "Testando conexao com DB ($DB_HOST:$DB_PORT)..."
DB_CONNECTED=0
for i in $(seq 1 15); do
    DB_RESULT=$(python -c "
import psycopg2, os
try:
    conn = psycopg2.connect(
        host=os.environ.get('DB_HOST','localhost'),
        port=int(os.environ.get('DB_PORT','5432')),
        user=os.environ.get('DB_USER','postgres'),
        password=os.environ.get('DB_PASSWORD',''),
        dbname=os.environ.get('DB_NAME','log_conversa'),
        connect_timeout=5
    )
    cur = conn.cursor()
    cur.execute('SELECT version()')
    ver = cur.fetchone()[0]
    cur.close()
    conn.close()
    print('OK: ' + ver)
except Exception as e:
    print('ERRO: ' + str(e))
" 2>&1)
    echo "  Tentativa $i/15: $DB_RESULT"
    if echo "$DB_RESULT" | grep -q "^OK:"; then
        DB_CONNECTED=1
        break
    fi
    sleep 2
done

if [ "$DB_CONNECTED" = "0" ]; then
    echo "AVISO: DB nao conectou apos 30s! A API vai iniciar mas endpoints podem falhar."
fi

# Iniciar agente em background (nao bloqueia)
python agente_ao_vivo_v4.py &
AGENT_PID=$!
echo "Agente iniciado (PID $AGENT_PID)"

sleep 2

# Iniciar API em foreground para que o container fique vivo
echo "Iniciando API Cockpit na porta 8000..."
exec uvicorn kb_api:app --host 0.0.0.0 --port 8000 --log-level info
