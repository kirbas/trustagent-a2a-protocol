# Kickoff Prompt — Delta #3 (TrustAgentAI inline co-sign service)

Copy everything below the `---` into a **fresh** Claude Code / coding-agent session started in `/home/ikarin/Trust-Agent`. It is self-contained; the new session starts cold.

---

Ты — coding-агент, продолжаешь работу над проектом **TrustAgentAI** (репо `/home/ikarin/Trust-Agent`).

## Контекст (прочитай ПЕРВЫМ, до любого кода)

1. `docs/execution_plan.md` — план исполнения, ориентация по репо, working agreement, backlog из 7 дельт. **Delta #3 — твоя задача.**
2. `docs/DISPUTE_HARDENING.md` — threat model и обоснования (особенно §3 «Third witness», §5.2/5.3 про residual risks витнеса).
3. `docs/testing/E2E_ANTIGRAVITY_PROMPT.md` — как гоняется полный стек локально (пригодится в конце).

Решения в этих доках УЖЕ ПРИНЯТЫ — не переоткрывай. Если считаешь решение ошибочным, подними явно, не меняй курс молча.

## Что уже сделано (Delta #1 и #2 — смерджены в main, ПЕРЕИСПОЛЬЗУЙ, не переизобретай)

- **Delta #1 — durable keys.** В `trust-agent/src/crypto.ts` есть `loadOrCreateKeyPair(kid, keystorePath, kek): Promise<KeyPair>` — грузит Ed25519-идентичность из зашифрованного (AES-256-GCM) keystore, KEK из env, fail-fast при отсутствии KEK. Прокси используют его на бутах, читая `KEYSTORE_PATH`/`KEYSTORE_KEK`. **Новый co-sign сервис ОБЯЗАН взять эту же функцию для своего собственного durable-ключа (ключ витнеса) со своим отдельным KEK — не генерируй ключ на старте.**
- **Delta #2 — hash-chain.** В `trust-agent/src/hash-chain.ts` есть shared-модуль: `GENESIS_PREV_HASH`, `computeRowHash(row): string`, `verifyChain(rows): {valid, error?}`, тип `ChainRow`. Экспортирован из `@trustagentai/a2a-core`. Прокси-`db.ts` уже сцепляют строки `envelopes` через `seq`+`prev_hash`. **Собственную hash-chain co-sign сервиса стройте НА ЭТОМ ЖЕ модуле — не пишите второй.**
- **Тест-раннер.** Vitest уже стоит в `trust-agent/` (`npm test`, `npm run test:coverage`, порог покрытия 80% через `vitest.config.ts`, тест-файлы `src/*.test.ts` исключены из tsc-билда). Для нового TS-сервиса подними аналогичный Vitest, если он в отдельном пакете.
- **Внимание — активный хук GateGuard.** Перед первым Bash и перед каждым Write/Edit среда потребует «fact-forcing»: назвать что делаешь, кто вызывает файл, подтвердить отсутствие дубля, процитировать инструкцию. Это нормально — просто отвечай на 4 пункта и повторяй операцию. При деструктивных командах (`rm -rf`) — отдельное подтверждение.

## Бранч

Ветка `feat/delta-3-cosign` УЖЕ создана от актуального main и запушена. Работай в ней. НЕ коммить в main, НЕ мерджи сам — в конце открой PR.

## Задача — Delta #3 «TrustAgentAI inline co-sign service»

Нужен **новый сервис-витнес**, независимый от обоих банков, который co-подписывает транзакцию **инлайн между Phase 2 и Phase 3** хендшейка, ведёт **собственную append-only hash-chain**, и **гейтит финальность**: транзакция без валидной co-подписи витнеса не считается завершённой. Это и есть «третий независимый ключ» из threat-model (закрывает fabrication при сговоре двух банков).

### Где именно врезаться (точные точки в коде)

Трёхфазный протокол: **IntentEnvelope (Phase 1, Proxy A подписывает)** → **AcceptanceReceipt (Phase 2, Proxy B подписывает)** → **ExecutionEnvelope (Phase 3, Proxy B контр-подписывает)**. Все три связаны `trace_id`.

Оркестратор — `ProxyAGateway.forwardToolCall` в `trust-agent/src/trust-proxy.ts` (~строки 108–200):
- Шаг 2 (`~L134–149`): POST `/accept` на Proxy B → получает `AcceptanceReceipt`.
- Шаг 3 (`~L151–159`): выполняет tool.
- Шаг 4–5 (`~L161–186`): строит ExecutionEnvelope → POST `/executed` на Proxy B → dual-signed receipt.

**Врезка co-sign: между получением AcceptanceReceipt (конец шага 2) и финализацией.** Рекомендация (settled в DISPUTE_HARDENING §3, «inline, before it can complete»): после того как есть Intent+Acceptance, Proxy A вызывает витнес; витнес проверяет обе подписи, co-подписывает дайджест транзакции, аппендит запись в свою hash-chain, возвращает co-signature. Без успешной co-подписи — транзакция не финализируется (в MVP: возвращать MCP-ошибку или деградированную метку; полноценный degraded-mode — это Delta #9, здесь только sync inline path + гейт).

### Что построить

1. **Новый сервис `trust-agent-cloud/`** (или обсуди имя) — отдельный TS/Express-сервис по образцу прокси (ESM, tsconfig NodeNext). Эндпоинт вроде `POST /co-sign`, принимающий `{ intent, acceptance }` (или их дайджесты), возвращающий `{ cosignature, seq, prev_hash }`.
   - Собственный durable-ключ через `loadOrCreateKeyPair` (Delta #1), свой `KEYSTORE_PATH`/`KEYSTORE_KEK`, отдельный от банков.
   - Своя SQLite + hash-chain через shared `hash-chain.ts` (Delta #2). Свой `GET /verify-chain`.
   - `GET /health`.
2. **Проводка в `ProxyAGateway`**: конфиг получает endpoint витнеса; между Phase 2 и Phase 3 — вызов `/co-sign`; результат приложить в `_a2a` (рядом с intent/acceptance/execution envelopes) и/или в ExecutionEnvelope; при провале co-sign — гейт финальности.
3. **docker-compose.yml**: новый сервис `trust-agent-cloud` со своим data-volume и `TRUSTAGENT_KEYSTORE_KEK` (env-плейсхолдер в `.env.example`, реальное — в gitignored `.env`). Прокси A получает `TRUSTAGENT_URL`.
4. **Не ломать wire-compat**: форма JSON-конверта, правило `signed_digest` = `SHA-256(JCS(envelope − signatures))`, имена SSE-событий. Co-подпись — аддитивна.

## Метод — строгий TDD (требование проекта)

RED (падающий тест, убедись что реально падает) → GREEN (минимальная реализация) → REFACTOR. Покрытие ≥80% на новых модулях. Чистая логика (проверка подписей, co-sign, построение звена chain) — в тестируемых модулях `trust-agent/src`; сетевую/SQL-обвязку сервиса покрывай интеграционно.

### Тесты (написать ПЕРВЫМИ)
- Витнес отвергает запрос, если подпись Intent или Acceptance невалидна.
- Успешный co-sign: возвращает Ed25519-подпись, проверяемую под durable-ключом витнеса.
- Co-sign аппендит ровно одно звено в hash-chain витнеса; `verifyChain` остаётся valid; дубликат (тот же trace_id) не двигает цепь / идемпотентен.
- `ProxyAGateway`: при недоступном/отказавшем витнесе транзакция НЕ финализируется как валидная (гейт срабатывает), а не молча проходит.
- Ключ витнеса переживает рестарт (тот же public key) — как в Delta #1.

## Acceptance criteria
- Транзакция без валидной co-подписи витнеса не проходит как финальная.
- Витнес независим: свой durable-ключ (свой KEK, отдельный от банковских и от БД), своя anchored-ready hash-chain.
- Байты приватных ключей никогда не в логах/в SQLite.
- Существующий happy-path (демо через `/trigger` → Intent/Accept/Execute) продолжает работать, теперь с co-подписью в `_a2a`.
- `npm run build` зелёный в `trust-agent/`, обоих прокси и новом сервисе; тесты зелёные; покрытие ≥80% на новых модулях.

## Ограничения
- Никаких секретов в исходниках (`.env` gitignored).
- Иммутабельность, файлы ≤~400 строк, функции ≤~50 строк.
- Conventional commits (`feat:`/`test:`/`refactor:`/`docs:`), attribution отключён.
- Один PR из `feat/delta-3-cosign` в main, НЕ self-merge.

## По завершении
Убедись что build+тесты зелёные и покрытие ≥80%. Обнови `docs/testing/E2E_ANTIGRAVITY_PROMPT.md` секцией про проверку co-подписи и `/verify-chain` витнеса. Открой PR. Кратко отчитайся: что сделано, вывод тестов/покрытия, остаточные риски (напр. «TrustAgentAI + один банк» НЕ закрыт — это осознанный residual из §5.3), что осталось для Delta #4 (anchoring HEAD чекпоинта + heartbeat).
