#!/bin/sh
# Sends what Claude Code hands a hook on to the uketsugi server, with the origin remote of the
# directory the session started in, and prints the server's answer: that is the hook's output.
#
# Whatever goes wrong (no server, a token it refuses, no curl) nothing is printed and the hook
# succeeds, so the session goes on as if the plugin were not installed. A server that does not
# answer is waited on for three seconds and no longer.

url=${CLAUDE_PLUGIN_OPTION_URL%/}
token=${CLAUDE_PLUGIN_OPTION_TOKEN:-}
if [ -z "$url" ] || [ -z "$token" ]; then exit 0; fi

# The remote names the project, as `git remote get-url origin` does for the agent. A password
# written into it stays here, and so does what a header cannot hold.
origin=$(git -C "${CLAUDE_PROJECT_DIR:-.}" remote get-url origin 2>/dev/null |
  sed -e 's#^\([A-Za-z+.-]*://\)[^/@]*@#\1#' | tr -d '"\\\r\n')

# curl reads the token and the remote from a file descriptor, never from its command line, where
# every user of the machine could read them.
curl --silent --fail --connect-timeout 1 --max-time 3 --config /dev/fd/3 \
  --data-binary @- "$url/api/hooks/claude-code" 3<<EOF
header = "Authorization: Bearer $token"
header = "Content-Type: application/json"
header = "X-Uketsugi-Origin: $origin"
EOF
exit 0
