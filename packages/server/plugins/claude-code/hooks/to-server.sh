#!/bin/sh
# Sends what Claude Code hands a hook on to the uketsugi server, with the origin remote of the
# directory the session started in. Two hooks name their event as the first argument: the start
# of a session, whose answer alone is printed, as the hook's output, and a prompt, which is sent
# only where its person turned that on.
#
# Whatever goes wrong (no server, a token it refuses, no curl) nothing is printed and the hook
# succeeds, so the session goes on as if the plugin were not installed. A server that does not
# answer is waited on for three seconds and no longer.

url=${CLAUDE_PLUGIN_OPTION_URL%/}
if [ -z "$url" ]; then exit 0; fi
# A server on this machine that you alone use takes no token; any other is sent the one you gave.
token=${CLAUDE_PLUGIN_OPTION_TOKEN:-}
authorization=${token:+header = \"Authorization: Bearer $token\"}

# What you ask is sent only where you turned on sending each turn (the plugin's `capture` option).
# Without the option nothing of a prompt leaves this machine. With it, the server is told so with
# everything sent, and keeps each turn for its language model alone.
case ${CLAUDE_PLUGIN_OPTION_CAPTURE:-} in
  true | True | TRUE | 1 | yes | on) capture=true ;;
  *) capture= ;;
esac
if [ "${1:-}" = UserPromptSubmit ] && [ -z "$capture" ]; then exit 0; fi

# The remote names the project, as `git remote get-url origin` does for the agent. A password
# written into it stays here, and so does what a header cannot hold.
origin=$(git -C "${CLAUDE_PROJECT_DIR:-.}" remote get-url origin 2>/dev/null |
  sed -e 's#^\([A-Za-z+.-]*://\)[^/@]*@#\1#' | tr -d '"\\\r\n')

# curl reads the token and the remote from a file descriptor, never from its command line, where
# every user of the machine could read them. It reads no settings file of the person's (-q).
answer=$(
  curl -q --silent --fail --connect-timeout 1 --max-time 3 --config /dev/fd/3 \
    --data-binary @- "$url/api/hooks/claude-code" 3<<EOF
$authorization
header = "Content-Type: application/json"
header = "X-Uketsugi-Origin: $origin"
header = "X-Uketsugi-Capture: $capture"
EOF
)

# Claude Code does what a hook's output says: it can keep the agent from stopping, end the session
# or approve a call. Whatever answers at the address, this prints one thing only: at the start of
# a session, one line that is a context for the agent and nothing else.
context='\{"hookSpecificOutput":\{"hookEventName":"SessionStart","additionalContext":"([^"\\]|\\.)*"\}\}'
if [ "${1:-}" = SessionStart ] && [ "$(printf '%s\n' "$answer" | wc -l)" -eq 1 ] &&
  printf '%s\n' "$answer" | LC_ALL=C grep -qxE "$context"; then
  printf '%s\n' "$answer"
fi
exit 0
