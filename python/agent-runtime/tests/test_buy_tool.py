"""The optional buy tool stays import-safe without the airlock-crypto extra."""

import pytest

from airlock_agent.tools import buy


def test_import_safe_and_reports_availability():
    # importing the tool never requires airlock-crypto
    assert isinstance(buy.crypto_available(), bool)


def test_buy_raises_clearly_when_crypto_missing():
    if buy.crypto_available():
        pytest.skip("airlock-crypto is installed in this env")
    with pytest.raises(ImportError):
        buy.buy("http://example/v1/chat/completions", max_price="0.01")
