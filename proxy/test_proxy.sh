#!/bin/bash

# Automated Proxy Testing Script for GitHub Actions
# Tests proxy health, token limiting, and basic functionality

set -e

echo "🧪 =============================================="
echo "🧪 PROXY AUTOMATED TESTING"
echo "🧪 =============================================="
echo ""

# Colors for output (works in GitHub Actions)
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

PROXY_URL="http://localhost:${PROXY_PORT:-14441}"
PASS_COUNT=0
TOTAL_TESTS=0

# Helper function for test results
test_result() {
  local test_name="$1"
  local passed="$2"
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  
  if [ "$passed" = "true" ]; then
    echo -e "${GREEN}✓ PASS${NC} - $test_name"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "${RED}✗ FAIL${NC} - $test_name"
  fi
}

# Test 1: Health Check
echo -e "${CYAN}📊 Test 1: Health Check${NC}"
HEALTH_RESPONSE=$(curl -s "$PROXY_URL/health" || echo '{"ok":false}')
HEALTH_OK=$(echo "$HEALTH_RESPONSE" | grep -o '"ok":true' || echo "")

if [ -n "$HEALTH_OK" ]; then
  test_result "Health endpoint returns ok:true" "true"
  
  # Extract values
  MAX_TOKENS=$(echo "$HEALTH_RESPONSE" | grep -o '"max_tokens_per_request":[0-9]*' | cut -d':' -f2 || echo "0")
  KEYS_COUNT=$(echo "$HEALTH_RESPONSE" | grep -o '"keys":[0-9]*' | cut -d':' -f2 || echo "0")
  
  echo "  └─ Max tokens per request: $MAX_TOKENS"
  echo "  └─ API keys configured: $KEYS_COUNT"
  
  if [ "$MAX_TOKENS" -gt 0 ]; then
    test_result "Token limiting is enabled (MAX_TOKENS=$MAX_TOKENS)" "true"
  else
    test_result "Token limiting is enabled" "false"
  fi
  
  if [ "$KEYS_COUNT" -gt 0 ]; then
    test_result "API keys loaded successfully ($KEYS_COUNT keys)" "true"
  else
    test_result "API keys loaded" "false"
  fi
else
  test_result "Health endpoint responds" "false"
  echo -e "${RED}ERROR: Proxy not responding or unhealthy${NC}"
  exit 1
fi

echo ""

# Test 2: Model List
echo -e "${CYAN}📊 Test 2: Model List (/api/tags)${NC}"
TAGS_RESPONSE=$(curl -s "$PROXY_URL/api/tags" || echo '{"models":[]}')
MODELS_COUNT=$(echo "$TAGS_RESPONSE" | grep -o '"name"' | wc -l)

if [ "$MODELS_COUNT" -gt 0 ]; then
  test_result "Model list endpoint returns models ($MODELS_COUNT models)" "true"
  echo "$TAGS_RESPONSE" | grep -o '"name":"[^"]*"' | head -3
else
  test_result "Model list endpoint responds" "false"
fi

echo ""

# Test 3: Simple Generate Request
echo -e "${CYAN}📊 Test 3: Generate Request with Token Limit${NC}"
GENERATE_RESPONSE=$(curl -s -X POST "$PROXY_URL/api/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.3:70b-instruct-q4_K_M",
    "prompt": "Say hello, in long text"
  }' 2>&1)

# Check if response contains expected fields
if echo "$GENERATE_RESPONSE" | grep -q '"response"'; then
  test_result "Generate endpoint responds with content" "true"
  
  # Extract eval_count (token count)
  EVAL_COUNT=$(echo "$GENERATE_RESPONSE" | grep -o '"eval_count":[0-9]*' | cut -d':' -f2 || echo "999")
  echo "  └─ Tokens generated: $EVAL_COUNT"
  
  # Check if within limit
  if [ "$EVAL_COUNT" -le "$MAX_TOKENS" ] || [ "$MAX_TOKENS" -eq 0 ]; then
    test_result "Token limit enforced ($EVAL_COUNT <= $MAX_TOKENS)" "true"
  else
    test_result "Token limit enforced" "false"
    echo "  └─ WARNING: Generated $EVAL_COUNT tokens, limit is $MAX_TOKENS"
  fi
else
  test_result "Generate endpoint responds" "false"
  echo "  └─ Response: $GENERATE_RESPONSE"
fi

echo ""

# Test 4: Chat Request
echo -e "${CYAN}📊 Test 4: Chat Request with Token Limit${NC}"
CHAT_RESPONSE=$(curl -s -X POST "$PROXY_URL/api/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.3:70b-instruct-q4_K_M",
    "messages": [
      {"role": "user", "content": "Hi"}
    ]
  }' 2>&1)

if echo "$CHAT_RESPONSE" | grep -q '"message"'; then
  test_result "Chat endpoint responds with message" "true"
  
  # Extract eval_count
  CHAT_EVAL_COUNT=$(echo "$CHAT_RESPONSE" | grep -o '"eval_count":[0-9]*' | cut -d':' -f2 || echo "999")
  echo "  └─ Tokens generated: $CHAT_EVAL_COUNT"
  
  if [ "$CHAT_EVAL_COUNT" -le "$MAX_TOKENS" ] || [ "$MAX_TOKENS" -eq 0 ]; then
    test_result "Chat token limit enforced ($CHAT_EVAL_COUNT <= $MAX_TOKENS)" "true"
  else
    test_result "Chat token limit enforced" "false"
  fi
else
  test_result "Chat endpoint responds" "false"
  echo "  └─ Response: $CHAT_RESPONSE"
fi

echo ""

# Test 5: Pool Status
echo -e "${CYAN}📊 Test 5: Pool Status Endpoint${NC}"
POOL_RESPONSE=$(curl -s "$PROXY_URL/pool/status" || echo '{"keys":[]}')
POOL_KEYS=$(echo "$POOL_RESPONSE" | grep -o '"id":[0-9]*' | wc -l)

if [ "$POOL_KEYS" -gt 0 ]; then
  test_result "Pool status endpoint responds ($POOL_KEYS backends)" "true"
else
  test_result "Pool status endpoint responds" "false"
fi

echo ""

# Final Summary
echo -e "${CYAN}═════════════════════════════════════════════${NC}"
echo -e "${CYAN}📋 TEST SUMMARY${NC}"
echo -e "${CYAN}═════════════════════════════════════════════${NC}"
echo ""
echo "Tests passed: $PASS_COUNT / $TOTAL_TESTS"
echo "Max token limit: $MAX_TOKENS"
echo "API keys: $KEYS_COUNT"
echo ""

if [ "$PASS_COUNT" -eq "$TOTAL_TESTS" ]; then
  echo -e "${GREEN}✓✓✓ ALL TESTS PASSED!${NC}"
  echo -e "${GREEN}✓✓✓ Proxy is ready for deployment${NC}"
  echo ""
  
  if [ "$MAX_TOKENS" -gt 0 ]; then
    SAVING_PERCENT=$((100 - (MAX_TOKENS * 100 / 256)))
    echo -e "${YELLOW}💰 Budget saving active: ~${SAVING_PERCENT}% compared to default 256 tokens${NC}"
  fi
  
  exit 0
else
  echo -e "${RED}✗✗✗ SOME TESTS FAILED${NC}"
  echo -e "${RED}✗✗✗ Please check proxy configuration${NC}"
  echo ""
  echo -e "${YELLOW}⚠️  Troubleshooting:${NC}"
  echo "   1. Check if proxy is running: curl $PROXY_URL/health"
  echo "   2. Verify environment variables in .env"
  echo "   3. Check proxy logs for errors"
  echo "   4. Ensure API keys are valid"
  
  exit 1
fi
