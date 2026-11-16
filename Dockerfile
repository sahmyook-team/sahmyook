FROM node:20-slim
# 결재검토용 도구: PDF(poppler), OCR(tesseract + 한국어), 이미지(Pillow), Claude API(anthropic)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-pil python3-lxml \
      poppler-utils tesseract-ocr tesseract-ocr-kor ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages pytesseract anthropic olefile cryptography six \
 && rm -rf /var/lib/apt/lists/*
# HWP(pyhwp): 설치 스크립트가 최신 setuptools에서 깨져서 소스만 받아 그대로 씀. 실패해도 빌드는 계속(HWP는 '직접 확인'으로 표시)
RUN mkdir -p /opt/pyhwp && cd /opt/pyhwp \
 && (pip3 download --no-deps --no-binary :all: --no-cache-dir pyhwp==0.1b15 -d . \
     && tar xzf pyhwp-0.1b15.tar.gz && mv pyhwp-0.1b15/src/hwp5 ./hwp5 && rm -rf pyhwp-0.1b15* \
     && for c in hwp5txt hwp5proc; do printf '#!/bin/sh\nPYTHONPATH=/opt/pyhwp exec python3 -c "import sys; from hwp5.%s import main; sys.argv[0]=\\"%s\\"; sys.exit(main())" "$@"\n' $c $c > /usr/local/bin/$c; chmod +x /usr/local/bin/$c; done \
     && hwp5txt --help >/dev/null) \
 || echo "pyhwp 설치 실패 - HWP는 직접 확인 필요로 처리"
WORKDIR /app
COPY . .
ENV PORT=8080
CMD ["node", "server.js"]
