FROM nginx:1.27-alpine

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY prompt.html /usr/share/nginx/html/index.html
COPY APAGAR.txt /usr/share/nginx/html/APAGAR.txt

EXPOSE 8000

CMD ["nginx", "-g", "daemon off;"]
