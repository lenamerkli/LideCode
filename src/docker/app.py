import base64
import mimetypes
import json
import os
import subprocess
from pathlib import Path
from flask import Flask, request
from secrets import compare_digest


ACCESS_TOKEN = os.environ.get('ACCESS_TOKEN')


app = Flask(__name__)


@app.before_request
def check_access():
    token = request.headers.get('Authorization', '')
    if not compare_digest(token, f'Bearer {ACCESS_TOKEN}'):  # noqa
        return {'error': 'Unauthorized'}, 401


@app.route('/', methods=['GET'])
def index():
    return {'status': 'ok'}


@app.route('/bash', methods=['POST'])
def bash():
    data = request.get_json()
    command = data.get('command', '')
    timeout = data.get('timeout', 60)
    directory = data.get('directory', '/home/agent/')
    venv = data.get('venv', None)
    max_chars = data.get('max_chars', 100000)
    if venv:
        command = f"source {venv}/bin/activate && {command}"
    if not command:
        return {'error': 'Missing command'}, 400
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=directory
        )
        response = {
            'stdout': result.stdout,
            'stderr': result.stderr,
            'returncode': result.returncode
        }
        # max_chars cuts off the entire tool response, not just stdout
        serialized = json.dumps(response)
        if len(serialized) > max_chars:
            response = {'output': serialized[:max_chars]}
        return response
    except Exception as e:
        return {'error': str(e)}, 500


@app.route('/read_file', methods=['POST'])
def read_file():
    data = request.get_json()
    path_str = data.get('path', '')
    if not path_str:
        return {'error': 'Missing path'}, 400
    start_line = data.get('start_line', 1) or 1
    end_line = data.get('end_line', 1000)
    max_chars = data.get('max_chars', 1000000)
    start_char = data.get('start_char', 0) or 0
    end_char = data.get('end_char', 100000)
    try:
        path = Path(path_str)
        if not path.exists():
            return {'error': f'File not found: {path_str}'}, 404
        if not path.is_file():
            return {'error': f'Not a file: {path_str}'}, 400
        content = path.read_text(encoding='utf-8', errors='replace')
        lines = content.splitlines(keepends=True)

        # Start position: the further of start_line (1-indexed -> char offset)
        # and start_char (0-indexed) wins.
        line_start_offset = sum(len(line) for line in lines[:max(start_line - 1, 0)])
        offset = max(line_start_offset, max(start_char, 0))

        # End position: the further of end_line (exclusive) and end_char
        # (exclusive) wins. Both are absolute character offsets here.
        line_end_offset = sum(len(line) for line in lines[:end_line])
        char_end_offset = offset + max(end_char, 0)
        end_offset = max(line_end_offset, char_end_offset)

        text = content[offset:end_offset]
        if len(text) > max_chars:
            text = text[:max_chars]
        return {'content': text, 'first_char': offset, 'last_char': end_offset - 1, 'first_line': None, 'last_line': None}
    except ValueError as e:
        return {'error': str(e)}, 400
    except Exception as e:
        return {'error': str(e)}, 500


@app.route('/write_to_file', methods=['POST'])
def write_to_file():
    data = request.get_json()
    path_str = data.get('path', '')
    content = data.get('content', '')
    if not path_str:
        return {'error': 'Missing path'}, 400
    try:
        path = Path(path_str)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        return {'characters': len(content)}
    except ValueError as e:
        return {'error': str(e)}, 400
    except Exception as e:
        return {'error': str(e)}, 500


@app.route('/replace_in_file', methods=['POST'])
def replace_in_file():
    data = request.get_json()
    path_str = data.get('path', '')
    search = data.get('search', '')
    replace = data.get('replace', '')
    read = data.get('read', False)

    if not path_str:
        return {'error': 'Missing path'}, 400
    if not search:
        return {'error': 'Missing search text'}, 400

    try:
        path = Path(path_str)
        if not path.exists():
            return {'error': f'File not found: {path_str}'}, 404
        if not path.is_file():
            return {'error': f'Not a file: {path_str}'}, 400
        current_content = path.read_text(encoding='utf-8')
        search_len = len(search)
        replace_len = len(replace)
        delta = replace_len - search_len
        occurrences = []
        start_search_idx = 0
        match_count = 0
        while True:
            orig_idx = current_content.find(search, start_search_idx)
            if orig_idx == -1:
                break
            new_idx = orig_idx + (match_count * delta)
            # occurrences.append({
            #     'original_index': orig_idx,
            #     'new_index': new_idx,
            #     'original_span': [orig_idx, orig_idx + search_len],
            #     'new_span': [new_idx, new_idx + replace_len]
            # })
            occurrences.append({
                'old_start': orig_idx,
                'old_end': orig_idx + search_len - 1,
                'new_start': new_idx,
                'new_end': new_idx + replace_len - 1
            })
            start_search_idx = orig_idx + search_len
            match_count += 1
        if not occurrences:
            return {'error': 'Search text not found in file'}, 400
        new_content = current_content.replace(search, replace)
        path.write_text(new_content, encoding='utf-8')
        response: dict = {
            'replacements': len(occurrences),
            'indices': occurrences
        }
        if read:
            response['content'] = new_content
        return response
    except ValueError as e:
        return {'error': str(e)}, 400
    except Exception as e:
        return {'error': str(e)}, 500


@app.route('/view_image', methods=['POST'])
def view_image():
    data = request.get_json()
    path_str = data.get('path', '')
    if not path_str:
        return {'error': 'Missing path'}, 400
    try:
        path = Path(path_str)
        if not path.exists():
            return {'error': f'File not found: {path_str}'}, 404
        if not path.is_file():
            return {'error': f'Not a file: {path_str}'}, 400
        mime, _ = mimetypes.guess_type(path_str)
        if mime not in ('image/png', 'image/jpeg', 'image/webp'):
            mime = 'image/png'
        content = path.read_bytes()
        encoded = base64.b64encode(content).decode('ascii')
        return {
            'mime': mime,
            'data_url': f'data:{mime};base64,{encoded}'
        }
    except Exception as e:
        return {'error': str(e)}, 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=50000)
