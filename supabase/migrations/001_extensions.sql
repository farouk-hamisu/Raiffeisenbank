-- Raiffeisen Bank - Migration 001
-- Enable required extensions

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";