FROM node:16.10

COPY yarn.lock .
COPY package.json .
RUN yarn install
COPY . .

ENTRYPOINT ["yarn", "--silent", "generate"]
CMD [""]
