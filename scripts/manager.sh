#!/bin/bash
# manager.sh - The Architect (Claude Opus)
# Creates a prd.json with detailed user stories from a feature request
#
# Usage: ./manager.sh <path-to-repo> <user-request>

set -e

REPO_PATH="$1"
USER_REQUEST="$2"

if [ -z "$REPO_PATH" ] || [ -z "$USER_REQUEST" ]; then
    echo "Usage: ./manager.sh <path-to-repo> <user-request>"
    exit 1
fi

if [ ! -d "$REPO_PATH" ]; then
    echo "Error: Repository path does not exist: $REPO_PATH"
    exit 1
fi

echo "Manager (Opus) is analyzing the request..."
echo "Repository: $REPO_PATH"
echo "Request: $USER_REQUEST"
echo ""

# Check if claude CLI is available
if ! command -v claude &> /dev/null; then
    echo "Warning: claude CLI not found. Creating sample prd.json for demonstration."

    # Generate a branch name from the request
    BRANCH_NAME=$(echo "$USER_REQUEST" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | cut -c1-30)

    # Create a sample prd.json for demonstration
    cat > "$REPO_PATH/prd.json" << EOF
{
  "featureName": "$USER_REQUEST",
  "branchName": "feature/$BRANCH_NAME",
  "description": "Implementation of: $USER_REQUEST",
  "userStories": [
    {
      "id": "story-1",
      "title": "Analyze requirements",
      "description": "Understand the existing codebase and plan the implementation",
      "acceptanceCriteria": [
        "Review existing code structure",
        "Identify files to modify",
        "Document implementation approach"
      ],
      "priority": 1,
      "passes": false
    },
    {
      "id": "story-2",
      "title": "Implement core functionality",
      "description": "Build the main feature as requested",
      "acceptanceCriteria": [
        "Feature works as described",
        "Code follows existing patterns",
        "No TypeScript/lint errors"
      ],
      "priority": 2,
      "passes": false
    },
    {
      "id": "story-3",
      "title": "Add tests and documentation",
      "description": "Write tests and update documentation",
      "acceptanceCriteria": [
        "Tests pass",
        "Code is documented",
        "README updated if needed"
      ],
      "priority": 3,
      "passes": false
    }
  ]
}
EOF

    echo "Created prd.json in $REPO_PATH"
    echo ""
    echo "Note: This is a sample PRD. For production use, install the Claude CLI"
    echo "and set your ANTHROPIC_API_KEY to generate detailed, context-aware PRDs."
    exit 0
fi

# Use direct Anthropic API for maximum reasoning capability
unset ANTHROPIC_BASE_URL
export ANTHROPIC_MODEL="${MANAGER_MODEL:-claude-3-opus-20240229}"

# Generate branch name from request
BRANCH_NAME=$(echo "$USER_REQUEST" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed 's/[^a-z0-9-]//g' | cut -c1-30)

# The Meta-Prompt for the Manager
META_PROMPT="You are a Senior Technical Architect creating a Product Requirements Document (PRD) for an AI coding assistant.

User Request: \"$USER_REQUEST\"

Your task:
1. ANALYZE the repository structure and relevant files in $REPO_PATH
2. CREATE a file named 'prd.json' in the root of '$REPO_PATH'
3. The prd.json must follow this EXACT structure:

\`\`\`json
{
  \"featureName\": \"Human-readable feature name\",
  \"branchName\": \"feature/$BRANCH_NAME\",
  \"description\": \"Detailed description of what will be built\",
  \"userStories\": [
    {
      \"id\": \"story-1\",
      \"title\": \"Short title\",
      \"description\": \"Detailed description of this specific task\",
      \"acceptanceCriteria\": [
        \"Specific, testable criterion 1\",
        \"Specific, testable criterion 2\"
      ],
      \"priority\": 1,
      \"passes\": false
    }
  ]
}
\`\`\`

CRITICAL RULES for user stories:
- Each story must be SMALL enough to complete in ONE iteration
- Stories should be ordered by dependency (implement prerequisites first)
- Priority 1 is highest priority (do first)
- Acceptance criteria must be SPECIFIC and TESTABLE
- Include quality checks (typecheck, lint, test) in criteria where appropriate
- DO NOT create stories larger than: \"add a component\", \"modify a file\", \"add a database column\"

BAD story (too large):
- \"Build the entire dashboard\"

GOOD stories (right-sized):
- \"Create dashboard layout component\"
- \"Add navigation sidebar to dashboard\"
- \"Implement user profile section\"
- \"Add activity feed component\"

Write the prd.json file now. Output ONLY valid JSON, no markdown code fences."

# Run claude with the meta-prompt
cd "$REPO_PATH"
echo "$META_PROMPT" | claude -p . --print

echo ""
echo "Manager completed. prd.json has been created."
echo "You can now run the Ralph loop to execute the stories."
