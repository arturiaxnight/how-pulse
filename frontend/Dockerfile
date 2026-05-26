FROM nginx:1.27-alpine

COPY frontend/ /usr/share/nginx/html
COPY Metronomes/ /usr/share/nginx/html/Metronomes
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
