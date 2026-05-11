# Project Overview

This project is a terminal UI diff reviewer for Git repositories.

The goal is to let a user launch the app inside any Git repo and review the current changes in a focused TUI:

- The right side shows changed files in a file tree.
- The left side shows the diff for the selected file.
- Users can add comments to one line or a range of lines.
- Users can then dispatch an AI agent with a prompt plus the comments they created.

At a high level, this is an interactive review workflow: inspect changed files, annotate specific code, then hand structured review context to an AI agent for follow-up work.
