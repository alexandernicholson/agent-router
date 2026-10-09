import os, pty, select, time, sys, re, json
# Drive an interactive Claude Code session in a pty, as a real user would.
os.environ["CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"] = "1"
pid, fd = pty.fork()
if pid == 0:
    os.chdir("/tmp")
    os.execvp("claude", ["claude", "--model", "claude-haiku-4-5-20251001"])
buf = b""
def pump(secs):
    global buf
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try: buf += os.read(fd, 65536)
            except OSError: return
def send(s): os.write(fd, s.encode())
pump(25)
for trust in (b"trust", b"Yes, proceed", b"Do you trust"):
    if trust in buf: send("\r"); pump(8); break
send("Reply with only: OK\r"); pump(40)
send("Reply with only: OK2\r"); pump(40)
text = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", buf).decode("utf-8", "replace")
bar = [l for l in text.splitlines() if "TTL" in l or "keepalive" in l.lower() or "%" in l]
print("--- cache bar lines seen:")
for l in bar[-6:]: print("  ", l.strip()[:160])
send("/keepalive\r"); pump(10)
text = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", buf).decode("utf-8", "replace")
print("--- dashboard excerpt:")
for l in [l for l in text.splitlines() if "Prompt cache" in l or "Now" in l or "Session" in l][-4:]: print("  ", l.strip()[:160])
open("/tmp/screen.txt","w").write(text)
print("--- bar lines:")
for l in [l for l in text.splitlines() if "TTL" in l or "ETA" in l][-3:]: print("  ", l.strip()[:150])
print("--- last 25 screen lines:")
for l in [l for l in text.splitlines() if l.strip()][-25:]: print("  ", l.rstrip()[:150])
os.kill(pid, 9)
