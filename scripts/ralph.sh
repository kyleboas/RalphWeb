#!/bin/bash
# ralph.sh - Autonomous AI Agent Loop
# Based on the snarktank/ralph pattern
#
# Each iteration is a fresh instance with clean context.
# Memory persists via git history, progress.txt, and prd.json
#
# Usage: ./ralph.sh [max_iterations] [--tool claude|amp]

set -e

# Configuration
MAX_ITERATIONS="${1:-10}"
TOOL="claude"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Parse arguments
for arg in "$@"; do
    case $arg in
        --tool)
            shift
            TOOL="$1"
            shift
            ;;
        [0-9]*)
            MAX_ITERATIONS="$arg"
            ;;
    esac
done

# Files
PRD_FILE="$PROJECT_ROOT/prd.json"
PROGRESS_FILE="$PROJECT_ROOT/progress.txt"
LOG_DIR="$PROJECT_ROOT/logs"
LOG_FILE="$LOG_DIR/ralph_$(date +%Y%m%d_%H%M%S).log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo -e "${BLUE}[Ralph]${NC} $1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

error() {
    echo -e "${RED}[Error]${NC} $1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1" >> "$LOG_FILE"
}

success() {
    echo -e "${GREEN}[Success]${NC} $1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] SUCCESS: $1" >> "$LOG_FILE"
}

# Ensure required files exist
mkdir -p "$LOG_DIR"

if [ ! -f "$PRD_FILE" ]; then
    error "No prd.json found. Create one first or use the PRD skill."
    echo ""
    echo "Example prd.json structure:"
    cat << 'EOF'
{
  "featureName": "My Feature",
  "branchName": "feature/my-feature",
  "userStories": [
    {
      "id": "story-1",
      "title": "Add login button",
      "description": "Add a login button to the header",
      "acceptanceCriteria": ["Button is visible", "Button triggers auth flow"],
      "priority": 1,
      "passes": false
    }
  ]
}
EOF
    exit 1
fi

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
    echo "# Progress Log" > "$PROGRESS_FILE"
    echo "Created: $(date)" >> "$PROGRESS_FILE"
    echo "" >> "$PROGRESS_FILE"
fi

# Check for required tools
check_tool() {
    if ! command -v "$1" &> /dev/null; then
        error "$1 is required but not installed."
        exit 1
    fi
}

check_tool "jq"
check_tool "git"

# Get branch name from PRD
BRANCH_NAME=$(jq -r '.branchName // "feature/ralph-work"' "$PRD_FILE")
FEATURE_NAME=$(jq -r '.featureName // "Unknown Feature"' "$PRD_FILE")

log "Starting Ralph loop for: $FEATURE_NAME"
log "Branch: $BRANCH_NAME"
log "Max iterations: $MAX_ITERATIONS"
log "Tool: $TOOL"
echo ""

# Create or switch to feature branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "$BRANCH_NAME" ]; then
    if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
        git checkout "$BRANCH_NAME"
    else
        git checkout -b "$BRANCH_NAME"
    fi
    log "Switched to branch: $BRANCH_NAME"
fi

# Main loop
ITERATION=0
while [ $ITERATION -lt $MAX_ITERATIONS ]; do
    ((ITERATION++))
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log "Iteration $ITERATION / $MAX_ITERATIONS"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Check if all stories are complete
    INCOMPLETE_COUNT=$(jq '[.userStories[] | select(.passes == false)] | length' "$PRD_FILE")

    if [ "$INCOMPLETE_COUNT" -eq 0 ]; then
        success "All stories complete!"
        echo "<promise>COMPLETE</promise>"

        # Final commit
        if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
            git add -A
            git commit -m "Ralph: All PRD items complete" || true
        fi

        exit 0
    fi

    log "Remaining stories: $INCOMPLETE_COUNT"

    # Get the highest priority incomplete story
    CURRENT_STORY=$(jq -r '[.userStories[] | select(.passes == false)] | sort_by(.priority) | first' "$PRD_FILE")
    STORY_ID=$(echo "$CURRENT_STORY" | jq -r '.id')
    STORY_TITLE=$(echo "$CURRENT_STORY" | jq -r '.title')

    log "Working on: [$STORY_ID] $STORY_TITLE"

    # Build the prompt for this iteration
    PROMPT=$(cat << EOF
You are Ralph, an autonomous AI coding agent working on: $FEATURE_NAME

## Current Task
**Story ID:** $STORY_ID
**Title:** $STORY_TITLE
**Description:** $(echo "$CURRENT_STORY" | jq -r '.description')

**Acceptance Criteria:**
$(echo "$CURRENT_STORY" | jq -r '.acceptanceCriteria | map("- " + .) | join("\n")')

## Your Instructions

1. **Implement** this single story completely
2. **Run quality checks** (typecheck, lint, test as appropriate)
3. **If checks pass:**
   - Commit your changes with message: "Ralph: Complete $STORY_ID - $STORY_TITLE"
   - Update prd.json to set this story's "passes" to true
   - Append learnings to progress.txt
4. **If checks fail:**
   - Fix the issues and try again
   - Do NOT mark the story as complete until checks pass

## Context Files
- prd.json: Full task list with completion status
- progress.txt: Learnings from previous iterations

## Completion Signal
When this story passes all checks and is marked complete, output exactly:
\`<promise>DONE</promise>\`

Do NOT output this signal until the story is verified complete.
EOF
)

    # Execute the AI tool
    if [ "$TOOL" = "claude" ]; then
        if command -v claude &> /dev/null; then
            cd "$PROJECT_ROOT"
            RESULT=$(echo "$PROMPT" | claude -p . --print 2>&1) || true
            echo "$RESULT" | tee -a "$LOG_FILE"
        else
            log "Claude CLI not found. Running in simulation mode."
            RESULT="[Simulation] Would implement: $STORY_TITLE"
            echo "$RESULT" | tee -a "$LOG_FILE"

            # Simulate completion after some iterations for testing
            if [ $ITERATION -ge 2 ]; then
                # Mark story complete in simulation
                jq --arg id "$STORY_ID" '(.userStories[] | select(.id == $id)).passes = true' "$PRD_FILE" > "${PRD_FILE}.tmp"
                mv "${PRD_FILE}.tmp" "$PRD_FILE"
                RESULT="<promise>DONE</promise>"
            fi
        fi
    elif [ "$TOOL" = "amp" ]; then
        if command -v amp &> /dev/null; then
            cd "$PROJECT_ROOT"
            RESULT=$(echo "$PROMPT" | amp --print 2>&1) || true
            echo "$RESULT" | tee -a "$LOG_FILE"
        else
            error "Amp CLI not found."
            exit 1
        fi
    fi

    # Check for story completion
    if echo "$RESULT" | grep -q "<promise>DONE</promise>"; then
        success "Story $STORY_ID completed!"

        # Commit if there are changes
        cd "$PROJECT_ROOT"
        if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
            git add -A
            git commit -m "Ralph: Complete $STORY_ID - $STORY_TITLE" || true
            log "Changes committed"
        fi
    fi

    # Safety checks
    if echo "$RESULT" | grep -q "Rate limit exceeded"; then
        error "Rate limit exceeded. Stopping to save budget."
        exit 1
    fi

    if echo "$RESULT" | grep -q "API key"; then
        error "API key error. Check your configuration."
        exit 1
    fi

    # Brief pause between iterations
    sleep 2
done

echo ""
error "Max iterations ($MAX_ITERATIONS) reached without completing all stories."
REMAINING=$(jq '[.userStories[] | select(.passes == false)] | length' "$PRD_FILE")
log "Remaining incomplete stories: $REMAINING"
exit 1
