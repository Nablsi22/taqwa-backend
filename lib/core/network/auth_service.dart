import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'api_client.dart';
import '../constants/api_constants.dart';

class AuthService {
  final _client = ApiClient.instance;
  final _storage = const FlutterSecureStorage();

  Future<Map<String, dynamic>> login(String username, String password) async {
    final response = await _client.dio.post(
      ApiConstants.login,
      data: {
        'username': username,
        'password': password,
      },
    );

    final data = response.data;

    // Store tokens securely
    await _storage.write(key: 'access_token', value: data['accessToken']);
    await _storage.write(key: 'refresh_token', value: data['refreshToken']);
    await _storage.write(key: 'user_role', value: data['user']['role']);
    await _storage.write(key: 'user_id', value: data['user']['id']);
    await _storage.write(
      key: 'username',
      value: data['user']['username'],
    );

    // Store profile name if available
    if (data['user']['profile'] != null &&
        data['user']['profile']['fullName'] != null) {
      await _storage.write(
        key: 'full_name',
        value: data['user']['profile']['fullName'],
      );
    }

    return data;
  }

  Future<Map<String, dynamic>> getMe() async {
    final response = await _client.dio.get(ApiConstants.me);
    return response.data;
  }

  Future<bool> isLoggedIn() async {
    final token = await _storage.read(key: 'access_token');
    return token != null;
  }

  Future<String?> getUserRole() async {
    return await _storage.read(key: 'user_role');
  }

  Future<String?> getFullName() async {
    return await _storage.read(key: 'full_name');
  }

  Future<void> logout() async {
    await _storage.deleteAll();
  }
}