FROM node:16.10

COPY yarn.lock .
COPY package.json .
COPY package-lock.json .
RUN yarn install
COPY . .

ENTRYPOINT ["yarn", "generate"]
CMD [""]
