export interface HttpRequest {
  url: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

export interface HttpResponse {
  status: number
  body: string
}

export interface Transport {
  request(request: HttpRequest): Promise<HttpResponse>
}

export class FetchTransport implements Transport {
  async request(request: HttpRequest): Promise<HttpResponse> {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    })

    return {
      status: response.status,
      body: await response.text(),
    }
  }
}
