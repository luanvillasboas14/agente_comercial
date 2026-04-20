FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY server/ ./server/

ARG VITE_OPENAI_API_KEY
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_KEY
ENV VITE_OPENAI_API_KEY=$VITE_OPENAI_API_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_KEY=$VITE_SUPABASE_KEY

RUN npm run build

FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY server/ ./server/
COPY --from=build /app/dist ./dist
COPY APAGAR.txt ./dist/APAGAR.txt

EXPOSE 8000

CMD ["node", "server.js"]
