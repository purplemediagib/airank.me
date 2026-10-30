FROM python:3.12-slim
RUN useradd --uid 10001 --create-home researcher
WORKDIR /research
COPY qualification.py test_qualification.py runner.py adapters.py service.py storage.py scheduler.py accounting.py test_accounting.py test_runner.py test_service.py test_storage.py test_scheduler.py ./
COPY inputs/ ./inputs/
COPY manifest_BOOTSTRAP_TEMPLATE.json ./
USER researcher
# Default operation is idle bootstrap, never live collection or secret access.
ENV TZ=UTC RESEARCH_THEN_IDLE=1
CMD ["python", "service.py"]
