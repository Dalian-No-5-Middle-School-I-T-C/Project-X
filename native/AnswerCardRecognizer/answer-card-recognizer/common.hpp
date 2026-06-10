#pragma once

#include <filesystem>
#include <string>

std::string path_to_utf8(const std::filesystem::path& path);
std::string wide_to_utf8(const std::wstring& value);
double round_to(double value, int digits);

