#!/usr/bin/env python3
"""Turn a LINE for Windows "Save chat" .txt export into structured JSONL.

The Windows export is a flat, space-separated text file:

    2024.09.18 Wednesday          <- date header
    18:48 王小明 你考試考得怎樣        <- HH:MM <sender> <body>
    還在等成績                    <- continuation of the previous message
    15:50 Message unsent.         <- unsent message, no sender

Note the separator is a plain SPACE, not a tab (the mobile export uses tabs).
A display name may itself contain spaces, so the sender cannot be taken as
"the first token" — this parser learns the set of senders first, then matches
the longest known name at the start of each line.

Usage:
    python parse_export.py export.txt                 -> export.jsonl + a summary
    python parse_export.py export.txt -o out.jsonl
    python parse_export.py export.txt --sender "王小明" --sender "李小華"
"""

import argparse
import collections
import io
import json
import re
import sys

DATE_RE = re.compile(r'^(\d{4})\.(\d{2})\.(\d{2}) (\w+)$')
TIME_RE = re.compile(r'^(\d{2}):(\d{2}) (.*)$', re.S)
CALL_RE = re.compile(r'^\d{1,2}:\d{2}$')
URL_RE = re.compile(r'https?://\S+')

# Bodies LINE writes verbatim for non-text content, in the English UI.
ATTACHMENT_KINDS = {
    'Stickers': 'sticker',
    'Sticker': 'sticker',
    'Photos': 'photo',
    'Photo': 'photo',
    'Videos': 'video',
    'Video': 'video',
    'Files': 'file',
    'File': 'file',
    'Voice message': 'voice',
    'Contacts': 'contact',
    'Contact': 'contact',
    'Albums': 'album',
    'Note': 'note',
    'Location': 'location',
}

UNSENT_BODIES = {'Message unsent.', 'Message unsent'}


def learn_senders(lines, explicit=None):
    """Work out the set of display names used in this export.

    Every message line starts with HH:MM followed by the sender. Counting the
    first token after the time gives the participants plus some noise from
    continuation lines; names used by a real participant dominate heavily.
    """
    if explicit:
        return sorted(set(explicit), key=len, reverse=True)

    first_tokens = collections.Counter()
    for line in lines:
        m = TIME_RE.match(line)
        if not m:
            continue
        rest = m.group(3)
        if rest in UNSENT_BODIES or rest.startswith('Message unsent'):
            continue
        tok = rest.split(' ', 1)[0]
        if tok:
            first_tokens[tok] += 1

    if not first_tokens:
        return []
    # A participant speaks far more than any word that happens to start a body.
    top = first_tokens.most_common()
    cutoff = max(3, int(top[0][1] * 0.02))
    names = [t for t, c in top if c >= cutoff]
    return sorted(set(names), key=len, reverse=True)


def split_sender(rest, senders):
    """Split 'sender body' using the longest known sender name that matches."""
    for name in senders:                      # senders are sorted longest-first
        if rest == name:
            return name, ''
        if rest.startswith(name + ' '):
            return name, rest[len(name) + 1:]
    # Unknown speaker: fall back to the first whitespace token.
    parts = rest.split(' ', 1)
    return parts[0], (parts[1] if len(parts) > 1 else '')


def classify(body):
    """Map a message body to (kind, extra fields)."""
    if body in ATTACHMENT_KINDS:
        return ATTACHMENT_KINDS[body], {}
    if CALL_RE.match(body):
        return 'call', {'duration': body}
    urls = URL_RE.findall(body)
    if urls:
        kind = 'location' if 'maps' in body and 'google' in body else 'text'
        return kind, {'urls': urls}
    return 'text', {}


def parse(path, explicit_senders=None):
    raw = io.open(path, 'rb').read()
    text = raw.decode('utf-8-sig')
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')

    senders = learn_senders(lines, explicit_senders)

    messages = []
    cur_date = None
    unknown = []

    for lineno, line in enumerate(lines, 1):
        if not line.strip():
            continue

        d = DATE_RE.match(line)
        if d:
            cur_date = f"{d.group(1)}-{d.group(2)}-{d.group(3)}"
            continue

        t = TIME_RE.match(line)
        if t:
            hh, mm, rest = t.group(1), t.group(2), t.group(3)

            if rest in UNSENT_BODIES or rest.startswith('Message unsent'):
                messages.append({
                    'date': cur_date, 'time': f'{hh}:{mm}',
                    'sender': None, 'kind': 'unsent', 'text': '',
                    'line': lineno,
                })
                continue

            sender, body = split_sender(rest, senders)
            if senders and sender not in senders:
                unknown.append((lineno, sender))
            kind, extra = classify(body)
            msg = {
                'date': cur_date, 'time': f'{hh}:{mm}',
                'sender': sender, 'kind': kind, 'text': body,
                'line': lineno,
            }
            msg.update(extra)
            messages.append(msg)
            continue

        # Not a date and not a timestamped line: a continuation of the
        # previous message (the sender pressed Shift+Enter).
        if messages:
            messages[-1]['text'] = (messages[-1]['text'] + '\n' + line).strip('\n')
            messages[-1]['multiline'] = True
        else:
            unknown.append((lineno, line))

    return messages, senders, unknown


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input')
    ap.add_argument('-o', '--output', help='JSONL output path (default: alongside input)')
    ap.add_argument('--sender', action='append', dest='senders',
                    help='declare a display name explicitly; repeatable')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    messages, senders, unknown = parse(args.input, args.senders)

    out = args.output or re.sub(r'\.txt$', '', args.input) + '.jsonl'
    with io.open(out, 'w', encoding='utf-8', newline='\n') as fh:
        for m in messages:
            fh.write(json.dumps(m, ensure_ascii=False) + '\n')

    if args.quiet:
        return

    by_kind = collections.Counter(m['kind'] for m in messages)
    by_sender = collections.Counter(m['sender'] or '(unsent)' for m in messages)
    dates = [m['date'] for m in messages if m['date']]

    print(f'wrote {out}')
    print(f'messages   : {len(messages)}')
    print(f'date range : {dates[0]} .. {dates[-1]}' if dates else 'date range : -')
    print(f'senders    : {", ".join(senders) if senders else "(none detected)"}')
    print('by sender  : ' + ', '.join(f'{k}={v}' for k, v in by_sender.most_common()))
    print('by kind    : ' + ', '.join(f'{k}={v}' for k, v in by_kind.most_common()))
    print(f'multiline  : {sum(1 for m in messages if m.get("multiline"))}')
    if unknown:
        print(f'UNRESOLVED : {len(unknown)} line(s), first few: {unknown[:5]}')


if __name__ == '__main__':
    sys.exit(main())
