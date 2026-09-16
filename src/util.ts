

export async function getRequest(url: string): Promise<string> {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
        throw new Error('Request failed: ' + response.status + ' ' + response.statusText + ': ' + (await response.text()));
    }
    return response.text();
}

export async function getRequestWithHeaders(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const init: RequestInit = { method: 'GET', headers: headers };
    if (signal !== undefined) {
        init.signal = signal;
    }
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error('Request failed with status ' + response.status + ': ' + await response.text());
    }
    return response.text();
}

export async function postRequest(url: string, json: unknown, headers?: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(json)
    };
    if (signal !== undefined) {
        init.signal = signal;
    }
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error('Request failed: ' + response.status + ' ' + response.statusText + ': ' + (await response.text()));
    }
    return response.text();
}
