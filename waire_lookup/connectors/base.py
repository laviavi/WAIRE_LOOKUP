from abc import ABC, abstractmethod
from datetime import datetime
import pandas as pd


class DataSource(ABC):
    @abstractmethod
    def load(self) -> pd.DataFrame: ...

    @abstractmethod
    def columns(self) -> list[str]: ...

    @abstractmethod
    def source_timestamp(self) -> datetime: ...

    @abstractmethod
    def is_stale(self) -> bool: ...
