#!/bin/bash
# Headai async job poller
# Usage: source this file, then call poll_headai_job "<initial_response_json>"
# Or: poll_headai_url "https://megatron.headai.com/analysis/..."

poll_headai_url() {
  local url="$1"
  local max_attempts="${2:-120}"
  local interval="${3:-3}"
  local attempt=0

  while [ $attempt -lt $max_attempts ]; do
    local response
    response=$(curl -s "$url")
    local status
    status=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','ready'))" 2>/dev/null)

    if [ "$status" = "ready" ] || [ -z "$status" ]; then
      # Job complete — fetch final result
      local location
      location=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('location',''))" 2>/dev/null)
      if [ -n "$location" ] && [ "$location" != "$url" ]; then
        curl -s "$location"
      else
        echo "$response"
      fi
      return 0
    fi

    echo "Polling attempt $((attempt+1))/$max_attempts — status: $status" >&2
    sleep "$interval"
    attempt=$((attempt+1))

    # Update URL if location changed
    local new_location
    new_location=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('location',''))" 2>/dev/null)
    if [ -n "$new_location" ]; then
      url="$new_location"
    fi
  done

  echo "ERROR: Job timed out after $((max_attempts * interval)) seconds" >&2
  return 1
}

poll_headai_job() {
  local response="$1"
  local location
  location=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('location',''))" 2>/dev/null)
  if [ -n "$location" ]; then
    poll_headai_url "$location"
  else
    echo "$response"
  fi
}
