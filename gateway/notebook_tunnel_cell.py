"""
Replacement for Steps 4 and 5 of `ollama_colab_tunnel.ipynb`.

Paste this into the notebook in place of the two cells that start the tunnel and
keep it alive. What changes: the random `*.trycloudflare.com` URL is no longer
something you copy anywhere. The notebook tells the gateway Worker what its URL
is for this session, and every app keeps pointing at the gateway's permanent
hostname instead.

Before the first run, store the token as a notebook secret so it is not pasted
into the cell:

  Colab   - the key icon in the left sidebar, "Notebook access" on
  Kaggle  - Add-ons -> Secrets, and attach it to the notebook

    LLM_GATEWAY_TOKEN   the same value as the Worker's GATEWAY_TOKEN secret

The gateway address is not a secret - it is useless without the token - so it
is baked in as DEFAULT_GATEWAY_URL below. Set an optional LLM_GATEWAY_URL
secret only if the Worker ever moves.

The cell also keeps watch after registering. A quick tunnel occasionally drops
on its own well before the session ends, and when it does, `cloudflared` exits
and takes the model's reachability with it. Restarting it here produces a new
random URL, which is exactly the thing the gateway exists to absorb: the watcher
re-registers and the apps never learn that anything moved.
"""

import os
import re
import subprocess
import threading
import time
from queue import Empty, Queue

import requests

# How long to wait for cloudflared to print its URL before giving up. The
# binary normally announces itself in a few seconds; 60 leaves room for a slow
# cold start without hanging the notebook indefinitely.
URL_TIMEOUT_S = 60

# How often to re-register while nothing has changed. This doubles as a
# liveness signal: the gateway reports how long ago it last heard from the
# notebook, so a stale age is how you tell "session ended" from "model is
# simply slow". Ten minutes keeps this inside the KV free tier's daily write
# allowance even with two notebooks running.
HEARTBEAT_S = 600

TUNNEL_CMD = [
    "./cloudflared",
    "tunnel",
    "--url",
    "http://localhost:11434",
    # Without this, Ollama sees a Host header it does not recognise and answers
    # 403 to every request as DNS-rebinding protection.
    "--http-host-header",
    "localhost:11434",
]


# The gateway's address is not a secret - it is useless to anyone without the
# token - so it is baked in here and only the token has to be stored. Override
# it with an LLM_GATEWAY_URL secret if the Worker is ever redeployed elsewhere.
DEFAULT_GATEWAY_URL = "https://leadpulse-llm.20230905090503u.workers.dev"


def _secret(name: str, default: str = "", masked: bool = True) -> str:
    """Reads a notebook secret: Colab, then Kaggle, then env, then a prompt.

    Falling all the way through to the prompt means the secret is not set up.
    On Kaggle, creating one is not enough - it has to be attached to this
    notebook under Add-ons -> Secrets, and the notebook needs Internet on.
    Typing it at the prompt works, but only for that session.
    """
    try:
        from google.colab import userdata  # type: ignore

        value = userdata.get(name)
        if value:
            return value.strip()
    except Exception:
        pass
    try:
        from kaggle_secrets import UserSecretsClient  # type: ignore

        value = UserSecretsClient().get_secret(name)
        if value:
            return value.strip()
    except Exception:
        pass
    value = os.environ.get(name, "").strip()
    if value:
        return value
    if default:
        return default
    if not masked:
        return input(f"{name}: ").strip()
    from getpass import getpass

    print(f"{name} is not stored - set it under Add-ons -> Secrets (Kaggle) or the")
    print("key icon in the sidebar (Colab) to stop being asked every session.")
    return getpass(f"{name}: ").strip()


GATEWAY_URL = _secret("LLM_GATEWAY_URL", default=DEFAULT_GATEWAY_URL, masked=False).rstrip("/")
GATEWAY_TOKEN = _secret("LLM_GATEWAY_TOKEN")

# The User-Agent is set deliberately. Cloudflare's edge bot rules reject some
# default library agents with a 403 before the Worker is ever reached -
# `Python-urllib/3` is blocked today and `python-requests` is not, which is not
# a distinction worth betting this notebook on.
AUTH = {
    "Authorization": f"Bearer {GATEWAY_TOKEN}",
    "User-Agent": "leadpulse-notebook/1",
}

if not GATEWAY_URL or not GATEWAY_TOKEN:
    raise SystemExit("LLM_GATEWAY_URL and LLM_GATEWAY_TOKEN must both be set - see the docstring.")


def start_tunnel() -> tuple[subprocess.Popen, str]:
    """Starts cloudflared and returns it with the public URL it announced.

    The output is drained on a background thread rather than read inline. A pipe
    nobody reads fills its buffer and blocks the writer, which would stall
    cloudflared mid-session - the original cell got away with it only because it
    stopped reading right after the URL appeared and then let the process own
    the cell for the rest of the session.
    """
    subprocess.run(["pkill", "-f", "cloudflared"], check=False)
    time.sleep(1)

    proc = subprocess.Popen(
        TUNNEL_CMD,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    found: Queue = Queue()

    def drain() -> None:
        pattern = re.compile(r"https://[a-zA-Z0-9][a-zA-Z0-9-]*\.trycloudflare\.com")
        announced = False
        for line in proc.stdout:  # type: ignore[union-attr]
            if not announced:
                match = pattern.search(line)
                if match:
                    announced = True
                    found.put(match.group(0))
        # Closing the queue with a sentinel matters: if cloudflared exits before
        # printing a URL, the waiter below should fail fast instead of sitting
        # out the whole timeout.
        if not announced:
            found.put("")

    threading.Thread(target=drain, daemon=True).start()

    try:
        url = found.get(timeout=URL_TIMEOUT_S)
    except Empty:
        proc.terminate()
        raise SystemExit("cloudflared never printed a tunnel URL - check the cell output above.")
    if not url:
        proc.terminate()
        raise SystemExit("cloudflared exited before opening a tunnel - check the cell output above.")
    return proc, url


def register(url: str, note: str = "") -> None:
    """Tells the gateway where the model is now. Raises if the gateway rejects it."""
    res = requests.post(
        f"{GATEWAY_URL}/__register",
        json={"url": url, **({"note": note} if note else {})},
        headers=AUTH,
        timeout=20,
    )
    if res.status_code != 200:
        raise SystemExit(f"gateway refused the registration (HTTP {res.status_code}): {res.text}")


def self_test() -> list[str]:
    """Checks the whole path - gateway, tunnel, Ollama - not just the tunnel."""
    res = requests.get(f"{GATEWAY_URL}/api/tags", headers=AUTH, timeout=30)
    res.raise_for_status()
    return [m.get("name") for m in res.json().get("models", [])]


proc, public_url = start_tunnel()
register(public_url, note="ollama via colab/kaggle notebook")

print("=" * 72)
print("Tunnel registered. This address is permanent - nothing to copy per session:")
print(f"  {GATEWAY_URL}")
print()
print("leadpulse .dev.vars :  LLM_BASE_URL=" + GATEWAY_URL)
print("SupportBook  .env   :  OLLAMA_API_BASE=" + GATEWAY_URL)
print()
print(f"(this session is behind it at {public_url})")
print("=" * 72)

try:
    print("Self-test through the gateway:", self_test())
except Exception as exc:
    print(f"Self-test failed: {exc}")

# Keep-alive, and a watchdog. The cell has to stay running either way - the
# tunnel is a child of this process - so it may as well notice a dead tunnel and
# put a new one in place.
print("\nWatching the tunnel. Leave this cell running.")
last_beat = time.time()
while True:
    time.sleep(15)
    if proc.poll() is not None:
        print(f"\ncloudflared exited (code {proc.returncode}); restarting it.")
        try:
            proc, public_url = start_tunnel()
            register(public_url, note="ollama via colab/kaggle notebook (restarted)")
            last_beat = time.time()
            print(f"Back up and re-registered. New tunnel: {public_url}")
        except SystemExit as exc:
            print(f"Could not restart the tunnel: {exc}")
            break
    elif time.time() - last_beat >= HEARTBEAT_S:
        try:
            register(public_url, note="ollama via colab/kaggle notebook (heartbeat)")
            last_beat = time.time()
        except SystemExit as exc:
            print(f"Heartbeat failed: {exc}")
