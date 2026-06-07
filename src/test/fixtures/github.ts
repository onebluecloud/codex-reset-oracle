export const githubIssueFixture = {
  id: 123456789,
  number: 42,
  html_url: "https://github.com/openai/codex/issues/42",
  title: "Quota did not reset after limit hit",
  body: "Codex usage quota still says limit reached after waiting.",
  created_at: "2026-06-07T06:30:00.000Z",
  updated_at: "2026-06-07T06:45:00.000Z",
  user: {
    login: "codex-user"
  },
  pull_request: undefined
};

export const unrelatedGithubIssueFixture = {
  ...githubIssueFixture,
  id: 987654321,
  number: 43,
  html_url: "https://github.com/openai/codex/issues/43",
  title: "Docs typo in setup guide",
  body: "The install instructions have a small typo.",
  user: {
    login: "docs-user"
  }
};
