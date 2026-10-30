FROM python:3.12-slim
RUN useradd --uid 10001 --create-home researcher
WORKDIR /research
COPY runner.py adapters.py service.py storage.py test_runner.py test_service.py test_storage.py ./
COPY inputs/ ./inputs/
USER researcher
# Default operation is idle bootstrap, never live collection or secret access.
ENV TZ=UTC RESEARCH_THEN_IDLE=1
CMD ["python", "service.py"]
