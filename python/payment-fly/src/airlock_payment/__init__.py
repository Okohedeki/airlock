"""airlock-payment — x402 Payment Middleware for Python ASGI apps.

Public surface:

  from airlock_payment import (
      PaymentConfig,         # union of FlatPaymentConfig | PerTokenPaymentConfig
      FlatPaymentConfig,
      PerTokenPaymentConfig,
      parse_payment_config,  # build a config from a dict (TOML / JSON / env)
      USDC_ADDRESSES,
      resolve_asset,

      PaymentRequired,
      PaymentRequirements,
      build_payment_required,

      CreditLedger,
      InMemoryCreditLedger,
      InsufficientBalanceError,

      Facilitator,
      HTTPFacilitator,
      VerifyResponse,
      SettleResponse,

      PaymentMiddleware,     # Starlette / FastAPI middleware
      TOKENS_USED_HEADER,
      CallerId,
  )
"""

from .config import (
    FlatPaymentConfig,
    PaymentConfig,
    PerTokenPaymentConfig,
    USDC_ADDRESSES,
    parse_payment_config,
    resolve_asset,
)
from .envelope import PaymentRequired, PaymentRequirements, build_payment_required
from .facilitator import Facilitator, HTTPFacilitator, SettleResponse, VerifyResponse
from .ledger import CreditLedger, InMemoryCreditLedger, InsufficientBalanceError
from .middleware import PaymentMiddleware
from .reporter import CallReporter, ReportableCall, report
from .types import CallerId, PaymentMode, SESSION_HEADER, TOKENS_USED_HEADER

__all__ = [
"CallReporter",
    "CallerId",
    "CreditLedger",
    "Facilitator",
    "FlatPaymentConfig",
    "HTTPFacilitator",
    "InMemoryCreditLedger",
    "InsufficientBalanceError",
    "PaymentConfig",
    "PaymentMiddleware",
    "PaymentMode",
    "PaymentRequired",
    "PaymentRequirements",
    "PerTokenPaymentConfig",
    "ReportableCall",
    "SettleResponse",
    "SESSION_HEADER",
    "TOKENS_USED_HEADER",
    "USDC_ADDRESSES",
    "VerifyResponse",
    "build_payment_required",
    "parse_payment_config",
    "report",
    "resolve_asset",
]

__version__ = "0.0.0"
