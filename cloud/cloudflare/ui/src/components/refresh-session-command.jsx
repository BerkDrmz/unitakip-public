import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { Button } from "./ui/primitives.jsx";

async function copyText(text, fallback) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!fallback) return false;
    fallback.focus();
    fallback.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
}

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text, fallback) => {
    const ok = await copyText(text, fallback);
    setCopied(ok ? "ok" : "fail");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2500);
  };
  return [copied, copy];
}

const shellArg = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function RefreshSessionCommand({ site, projectDirectory }) {
  const [copied, copy] = useCopy();
  const ref = useRef(null);
  const base = `${projectDirectory ? ".venv/bin/python" : "python3"} cloud/cloudflare/refresh-session.py ${site.id}`;
  const script = site.origin === "panel" ? `${base} --type ${site.type} --url ${shellArg(site.url)}` : base;
  const command = projectDirectory ? `cd ${shellArg(projectDirectory)} &&\n${script}` : script;

  return (
    <div className="mt-3 flex flex-wrap items-start gap-2">
      <textarea
        ref={ref}
        readOnly
        value={command}
        rows={projectDirectory ? 3 : 1}
        spellCheck={false}
        aria-label="Oturum yenileme komutu"
        onFocus={(event) => event.target.select()}
        className="min-w-0 flex-1 resize-none break-all rounded-2xl border border-rule bg-paper px-3 py-2 font-mono text-xs text-ink-2"
      />
      <Button type="button" variant="outline" size="sm" icon={copied === "ok" ? Check : ClipboardCopy} onClick={() => copy(command, ref.current)}>
        {copied === "ok" ? "Kopyalandı" : "Kopyala"}
      </Button>
    </div>
  );
}
