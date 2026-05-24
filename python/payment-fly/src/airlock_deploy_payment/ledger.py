"""Credit Balance store for per-token mode. Interface ships in v1; runtime in v1.1."""

from __future__ import annotations

from decimal import Decimal
from typing import Protocol


class InsufficientBalanceError(Exception):
    def __init__(self, caller: str, required: str, available: str) -> None:
        super().__init__(f"caller {caller} balance {available} < required {required}")
        self.caller = caller
        self.required = required
        self.available = available


class CreditLedger(Protocol):
    """Per-Caller USDC balance store. Implementations back this with KV / Postgres / etc."""

    async def get_balance(self, caller: str) -> str: ...
    async def credit(self, caller: str, amount_usdc: str) -> str: ...
    async def debit(self, caller: str, amount_usdc: str) -> str: ...


def _to_atomic(usdc: str) -> int:
    whole, _, frac = usdc.partition(".")
    frac_padded = (frac + "000000")[:6]
    return int((whole + frac_padded).lstrip("0") or "0")


def _from_atomic(atomic: int) -> str:
    s = str(atomic).rjust(7, "0")
    whole, frac = s[:-6], s[-6:].rstrip("0")
    return whole if frac == "" else f"{whole}.{frac}"


class InMemoryCreditLedger:
    """Per-process in-memory ledger. Loses balance on restart — use a persistent
    backing store in production. Uses int arithmetic on atomic units (6 decimals)
    to avoid Decimal/float drift."""

    def __init__(self) -> None:
        self._balances: dict[str, int] = {}

    async def get_balance(self, caller: str) -> str:
        return _from_atomic(self._balances.get(caller, 0))

    async def credit(self, caller: str, amount_usdc: str) -> str:
        next_atomic = self._balances.get(caller, 0) + _to_atomic(amount_usdc)
        self._balances[caller] = next_atomic
        return _from_atomic(next_atomic)

    async def debit(self, caller: str, amount_usdc: str) -> str:
        current = self._balances.get(caller, 0)
        charge = _to_atomic(amount_usdc)
        if charge > current:
            raise InsufficientBalanceError(
                caller, amount_usdc, _from_atomic(current)
            )
        next_atomic = current - charge
        self._balances[caller] = next_atomic
        return _from_atomic(next_atomic)


__all__ = [
    "CreditLedger",
    "InMemoryCreditLedger",
    "InsufficientBalanceError",
    # internal — exposed for tests
    "_to_atomic",
    "_from_atomic",
]


# unused import sanity (the Protocol path doesn't need Decimal anymore)
_ = Decimal
