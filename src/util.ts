

export function synchronousGetRequest(url: string): string {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false); // false = synchronous
    xhr.send(null);
    if (xhr.status === 200) {
        return xhr.responseText;
    } else {
        throw new Error('Request failed: ' + xhr.statusText);
    }
}

export function synchronousGetRequestWithHeaders(url: string, headers: Record<string, string>): string {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false); // false = synchronous
    for (const [key, value] of Object.entries(headers)) {
        xhr.setRequestHeader(key, value);
    }
    xhr.send(null);
    if (xhr.status === 200) {
        return xhr.responseText;
    } else {
        throw new Error('Request failed with status ' + xhr.status + ': ' + xhr.responseText);
    }
}

export function synchronousPostRequest(url: string, json: any): string {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, false); // false = synchronous
    xhr.send(JSON.stringify(json));
    if (xhr.status === 200) {
        return xhr.responseText;
    } else {
        throw new Error('Request failed: ' + xhr.statusText);
    }
}
