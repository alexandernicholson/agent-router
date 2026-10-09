# Install guide test

Follows [INSTALL.md](../../INSTALL.md) literally as a new user on Ubuntu 24.04 and checks every step, including the cache bar and `/keepalive` dashboard in a real interactive session.

```sh
docker build -t keepalive-install -f Dockerfile .
docker run --rm -t -e TERM=xterm-256color -e COLUMNS=160 \
  --env-file <(printf 'ANTHROPIC_BASE_URL=%s\nANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_BASE_URL" "$ANTHROPIC_API_KEY") \
  -v "$PWD":/w:ro keepalive-install sh /w/guide-test.sh
```

Every line printed is `PASS …` or `FAIL …`. It makes a few small model requests.
