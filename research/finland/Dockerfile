FROM python:3.12-slim
RUN useradd --uid 10001 --create-home researcher
WORKDIR /research
COPY runner.py adapters.py test_runner.py ./
COPY inputs/ ./inputs/
USER researcher
# Default operation is offline tests, never live collection or secret access.
CMD ["python", "-m", "unittest", "-v"]
