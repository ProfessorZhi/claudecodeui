#!/bin/bash
export PATH=/data/home/yale/work/sv-probe/v/bin:$PATH
cd /data/home/yale/work/sherpa-patch/sherpa-onnx
export SHERPA_ONNX_CMAKE_ARGS="-DSHERPA_ONNX_ENABLE_TTS=OFF -DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF -DSHERPA_ONNX_ENABLE_GPU=OFF -DSHERPA_ONNX_ENABLE_C_API=OFF -DSHERPA_ONNX_ENABLE_CHECK=OFF -DPython_INCLUDE_DIR=/data/home/yale/work/sherpa-patch/pydev/ext/usr/include/python3.12 -DPython3_INCLUDE_DIR=/data/home/yale/work/sherpa-patch/pydev/ext/usr/include/python3.12"
export CPLUS_INCLUDE_PATH=/data/home/yale/work/sherpa-patch/pydev/ext/usr/include/python3.12:/data/home/yale/work/sherpa-patch/pydev/ext/usr/include/x86_64-linux-gnu/python3.12
export C_INCLUDE_PATH=$CPLUS_INCLUDE_PATH
export SHERPA_ONNX_MAKE_ARGS="-j12"
python setup.py bdist_wheel
echo BUILD-EXIT $?
