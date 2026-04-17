FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src/ ./src/
COPY public/ ./public/

ARG VITE_OPENAI_API_KEY
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_KEY
ENV VITE_OPENAI_API_KEY=$VITE_OPENAI_API_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_KEY=$VITE_SUPABASE_KEY

RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
COPY APAGAR.txt /usr/share/nginx/html/APAGAR.txt

EXPOSE 8000

ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d
CMD ["nginx", "-g", "daemon off;"]
