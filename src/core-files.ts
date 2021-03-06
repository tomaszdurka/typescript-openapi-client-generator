import * as stream from "stream";

export interface ClientMiddleware {
  handle(
    apiRequest: ApiRequest,
    nextHandler: requestHandler,
  ): Promise<Response>;
}

export type requestHandler = (apiRequest: ApiRequest) => Promise<Response>;

export type jsonResponseHandler = (apiRequest: ApiRequest, response: any) => Promise<any>;

export type responseHandler = (response: Response) => Promise<any>;

export class Client {
  constructor(
    private readonly basePath: string,
    private readonly fetchApi: any,
    private readonly middlewares: Array<ClientMiddleware> = [],
    readonly jsonResponseHandler: jsonResponseHandler = async (apiRequest, response) => response,
  ) {}

  async _fetch(apiRequest: ApiRequest): Promise<Response> {
    const url = new URL(this.basePath + apiRequest.pathname);
    apiRequest.searchParams.forEach((value, key) =>
      url.searchParams.append(key, value),
    );

    const executeMiddleware = (apiRequest: ApiRequest, iterator: number): Promise<Response> => {
      if (!this.middlewares[iterator]) {
        return this.fetchApi(url.href, apiRequest);
      }
      return this.middlewares[iterator].handle(apiRequest, (apiRequest) =>
        executeMiddleware(apiRequest, iterator + 1),
      );
    };
    return executeMiddleware(apiRequest, 0);
  }

  async fetch(
    apiRequest: ApiRequest,
    responseHandler: responseHandler,
  ): Promise<any> {
    const response = await this._fetch(apiRequest);
    return await responseHandler(response);
  }
}

export class ApiRequestError extends Error {
  constructor(readonly request: ApiRequest, readonly response: Response) {
    super(
      `${request.method?.toUpperCase()} ${request.pathname} -> ${
        response.status
      } ${response.statusText}`,
    );
  }

  async toJSON() {
    delete this.request.agent;
    return {
      message: this.message,
      errorStack: this.stack,
      response: {
        status: this.response.status,
        statusText: this.response.statusText,
        body: await this.response.text(),
      },
      request: this.request,
    };
  }
}

export type ApiRequest = RequestInit & {
  searchParams: URLSearchParams;
  pathname: string;
  agent?: any;
};
