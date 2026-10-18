/** Minimal glob → RegExp: `**` (any folders), `*` (within a folder), `?`, `{a,b}`. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
      } else { re += '[^/]*'; }
    } else if (c === '?') { re += '[^/]'; }
    else if (c === '{') { re += '(?:'; }
    else if (c === '}') { re += ')'; }
    else if (c === ',') { re += '|'; }
    else { re += c.replace(/[.+^$()|[\]\\]/g, '\\$&'); }
  }
  return new RegExp('^' + re + '$', 'i');
}
