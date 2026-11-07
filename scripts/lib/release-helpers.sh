#!/usr/bin/env bash
# 发布工作流共用函数，供 GitHub Actions 的 run 步骤 source。
# 只用 gh、node 与 shell 内建命令；不依赖外部 jq。

# Release 正文里的归属标记：只有本工作流创建的草稿才会带这一行。
readonly RELEASE_MARKER='<!-- projectx-release-workflow -->'

# 把标签解析成它指向的提交。标签不存在时输出空串。
resolve_tag_commit() {
  local tag="$1"
  local ref
  ref="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/git/matching-refs/tags/${tag}" \
    --jq ".[] | select(.ref == \"refs/tags/${tag}\") | .object.type + \" \" + .object.sha")"
  [ -n "$ref" ] || return 0
  local type="${ref%% *}"
  local sha="${ref#* }"
  if [ "$type" = "tag" ]; then
    gh api "repos/${GITHUB_REPOSITORY}/git/tags/${sha}" --jq '.object.sha'
  else
    printf '%s\n' "$sha"
  fi
}

# 按标签找 Release，包含草稿（releases/tags 端点只返回已发布的 Release）。
find_release_json() {
  local tag="$1"
  gh api --paginate "repos/${GITHUB_REPOSITORY}/releases?per_page=100" \
    --jq "map(select(.tag_name == \"${tag}\")) | .[0] // empty"
}

# 从 find_release_json 的结果里取字段；字段缺失时输出空串。
release_field() {
  local json="$1"
  local field="$2"
  printf '%s' "$json" | node -e '
    const fs = require("node:fs");
    const release = JSON.parse(fs.readFileSync(0, "utf8"));
    const value = release[process.argv[1]];
    process.stdout.write(value === null || value === undefined ? "" : String(value));
  ' "$field"
}
