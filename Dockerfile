# This file is a template, and might need editing before it works on your project.
FROM node:14 AS base
WORKDIR /squizzy
COPY . .
RUN npm install
RUN npm audit fix
RUN npm run build 
WORKDIR /squizzy/studio
RUN npm install
RUN npm upgrade
#RUN npm audit fix
RUN npm run build

FROM node:14 AS release
WORKDIR /squizzy
COPY ./sanityClientConfig.js .
WORKDIR /squizzy/backend
COPY ./backend .
RUN npm install
#RUN npm audit fix
COPY --from=base /squizzy/dist ./app
COPY --from=base /squizzy/studio/dist ./studio
EXPOSE 3900
CMD [ "node", "index.js" ]
