cmake_minimum_required(VERSION 3.20)
project(ProjectXNative LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "Native scanner components require a Windows target; use the MinGW toolchain for cross compilation.")
endif()

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
find_package(OpenCV 4.13 REQUIRED COMPONENTS core imgproc imgcodecs objdetect)
find_path(NLOHMANN_JSON_INCLUDE_DIR nlohmann/json.hpp REQUIRED)

set(RECOGNIZER_DIR "${CMAKE_CURRENT_SOURCE_DIR}/AnswerCardRecognizer/answer-card-recognizer")
add_executable(answer-card-recognizer
  "${RECOGNIZER_DIR}/main.cpp"
  "${RECOGNIZER_DIR}/answer_recognition.cpp"
  "${RECOGNIZER_DIR}/common.cpp"
  "${RECOGNIZER_DIR}/layout_io.cpp"
  "${RECOGNIZER_DIR}/recognizer_limits.cpp"
  "${RECOGNIZER_DIR}/vision_utils.cpp")
target_include_directories(answer-card-recognizer PRIVATE "${NLOHMANN_JSON_INCLUDE_DIR}" ${OpenCV_INCLUDE_DIRS})
target_link_libraries(answer-card-recognizer PRIVATE ${OpenCV_LIBS})

set(BRIDGE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/ScannerBridge/scanner-bridge")
add_executable(scanner-bridge "${BRIDGE_DIR}/main.cpp" "${BRIDGE_DIR}/twain_controller.cpp")
target_include_directories(scanner-bridge PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/ScannerBridge/third_party/twain-dsm-2.5.1/include")
target_link_libraries(scanner-bridge PRIVATE gdiplus user32 gdi32 ole32)

foreach(component answer-card-recognizer scanner-bridge)
  target_compile_definitions(${component} PRIVATE UNICODE _UNICODE NOMINMAX _WIN32_WINNT=0x0601)
  if(MINGW)
    # TWAIN capability containers use the pointer aliasing conventions of the SDK/MSVC.
    target_compile_options(${component} PRIVATE -Wall -Wextra -fno-strict-aliasing)
    target_link_options(${component} PRIVATE -municode -static -static-libgcc -static-libstdc++ -Wl,--dynamicbase -Wl,--nxcompat)
  elseif(MSVC)
    target_compile_options(${component} PRIVATE /utf-8)
  endif()
endforeach()

install(TARGETS answer-card-recognizer scanner-bridge RUNTIME DESTINATION .)
