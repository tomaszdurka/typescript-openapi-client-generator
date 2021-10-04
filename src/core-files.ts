export interface ClientMiddleware {
    handle(
        apiRequest: ApiRequest,
        nextHandler: requestHandler,
    ): Promise<Response>;
}

export type requestHandler = (apiRequest: ApiRequest) => Promise<Response>;

export type jsonParser = (json) => Promise<any>

export class Client {
    constructor(
        private readonly basePath: string,
        private readonly fetchApi: any,
        private readonly middlewares: Array<ClientMiddleware> = [],
        readonly successJsonResponseParser: jsonParser = async (r) => r,
    ) {}

    async fetch(apiRequest: ApiRequest): Promise<Response> {
        const url = new URL(this.basePath + apiRequest.pathname);
        apiRequest.searchParams.forEach((value, key) =>
            url.searchParams.append(key, value),
        );

        const executeMiddleware = (apiRequest, iterator) => {
            if (!this.middlewares[iterator]) {
                return this.fetchApi(url.href, apiRequest);
            }
            return this.middlewares[iterator].handle(apiRequest, (apiRequest) =>
                executeMiddleware(apiRequest, iterator + 1),
            );
        };
        return executeMiddleware(apiRequest, 0);
    }
}

export type ApiRequest = RequestInit & {
    searchParams: URLSearchParams;
    pathname: string;
    agent?: any;
};

export class ResponseError extends Error {
    constructor(readonly response: Response, readonly body: any) {
        super(`${response.status} ${response.statusText}`);
    }
}
