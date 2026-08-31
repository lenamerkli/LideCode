

export async function getRequest(url: string): Promise<string> {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
        throw new Error('Request failed: ' + response.status + ' ' + response.statusText + ': ' + (await response.text()));
    }
    return response.text();
}

export async function getRequestWithHeaders(url: string, headers: Record<string, string>): Promise<string> {
    const response = await fetch(url, { method: 'GET', headers: headers });
    if (!response.ok) {
        throw new Error('Request failed with status ' + response.status + ': ' + await response.text());
    }
    return response.text();
}

export async function postRequest(url: string, json: unknown, headers?: Record<string, string>): Promise<string> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(json)
    });
    if (!response.ok) {
        throw new Error('Request failed: ' + response.status + ' ' + response.statusText + ': ' + (await response.text()));
    }
    return response.text();
}
