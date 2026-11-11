FROM python:3.12-slim
RUN useradd --uid 10001 --create-home researcher && mkdir -p /data/model-agreement-v01 && chown -R 10001:10001 /data
WORKDIR /research
COPY core.py adapters.py storage.py service.py analyze.py manifest_DRAFT.json ./
COPY inputs/ ./inputs/
USER researcher
ENV TZ=UTC RESEARCH_ACTION=idle RESEARCH_DATA_DIR=/data/model-agreement-v01
# Research only. Idle exits; an orchestration restart policy can still incur hosting charges.
CMD ["python", "service.py"]
