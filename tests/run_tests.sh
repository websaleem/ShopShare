#!/bin/bash

# Source environment variables if .env exists
if [ -f .env ]; then
    export $(cat .env | grep -v '#' | awk '/=/ {print $1}')
fi

# Ensure API Key is set
if [ -z "$LLM_MODEL_API_KEY" ]; then
    echo "Error: LLM_MODEL_API_KEY is not set. Please set it in your .env file."
    exit 1
fi

# Ensure Google model name doesn't have the litellm 'gemini/' prefix
CLEAN_MODEL_NAME="${LLM_MODEL_NAME:-gemini-flash-latest}"
CLEAN_MODEL_NAME="${CLEAN_MODEL_NAME#gemini/}"
# Map retired or restricted models to the latest flash alias
if [[ "$CLEAN_MODEL_NAME" =~ ^gemini-.*-pro$ ]] || [ "$CLEAN_MODEL_NAME" = "gemini-2.5-flash" ]; then
    CLEAN_MODEL_NAME="gemini-flash-latest"
fi

echo "Generating agents_llm_config.json..."
cat << JSON_EOF > tests/agents_llm_config.json
{
  "litellm": {
    "planner_agent": {
      "model_name": "${CLEAN_MODEL_NAME}",
      "model_api_key": "${LLM_MODEL_API_KEY}",
      "model_base_url": "https://generativelanguage.googleapis.com/v1beta/openai/"
    },
    "nav_agent": {
      "model_name": "${CLEAN_MODEL_NAME}",
      "model_api_key": "${LLM_MODEL_API_KEY}",
      "model_base_url": "https://generativelanguage.googleapis.com/v1beta/openai/"
    },
    "mem_agent": {
      "model_name": "${CLEAN_MODEL_NAME}",
      "model_api_key": "${LLM_MODEL_API_KEY}",
      "model_base_url": "https://generativelanguage.googleapis.com/v1beta/openai/"
    },
    "helper_agent": {
      "model_name": "${CLEAN_MODEL_NAME}",
      "model_api_key": "${LLM_MODEL_API_KEY}",
      "model_base_url": "https://generativelanguage.googleapis.com/v1beta/openai/"
    }
  }
}
JSON_EOF

echo "Starting TestZeus Hercules..."

# Activate virtual environment
source venv/bin/activate

# Run Hercules tests
python -m testzeus_hercules \
    --project-base tests \
    --input-file tests/input/shopshare_split.feature \
    --agents-llm-config-file tests/agents_llm_config.json \
    --agents-llm-config-file-ref-key litellm
HERCULES_EXIT_CODE=$?

echo "Done! Check tests/output and tests/proofs for results."

exit $HERCULES_EXIT_CODE
