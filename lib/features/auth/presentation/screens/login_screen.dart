import 'package:flutter/material.dart';
import 'package:dio/dio.dart';
import '../../../../core/theme/taqwa_colors.dart';
import '../../../../core/constants/app_strings.dart';
import '../../../../core/network/auth_service.dart';
import '../../../home/presentation/screens/admin_home_screen.dart';
import '../../../home/presentation/screens/instructor_home_screen.dart';
import '../../../home/presentation/screens/student_home_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen>
    with SingleTickerProviderStateMixin {
  final _formKey = GlobalKey<FormState>();
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  final _authService = AuthService();
  bool _isPasswordVisible = false;
  bool _isLoading = false;
  String? _errorMessage;

  late AnimationController _animController;
  late Animation<double> _fadeAnim;
  late Animation<Offset> _slideAnim;

  @override
  void initState() {
    super.initState();
    _animController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    );
    _fadeAnim = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(parent: _animController, curve: Curves.easeOut),
    );
    _slideAnim = Tween<Offset>(
      begin: const Offset(0, 0.3),
      end: Offset.zero,
    ).animate(
      CurvedAnimation(parent: _animController, curve: Curves.easeOutCubic),
    );
    _animController.forward();
    _checkExistingLogin();
  }

  Future<void> _checkExistingLogin() async {
    final isLoggedIn = await _authService.isLoggedIn();
    if (isLoggedIn && mounted) {
      final role = await _authService.getUserRole();
      _navigateToHome(role ?? 'STUDENT');
    }
  }

  @override
  void dispose() {
    _animController.dispose();
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  void _navigateToHome(String role) {
    Widget homeScreen;

    switch (role) {
      case 'ADMIN':
        homeScreen = const AdminHomeScreen();
        break;
      case 'INSTRUCTOR':
        homeScreen = const InstructorHomeScreen();
        break;
      case 'STUDENT':
      default:
        homeScreen = const StudentHomeScreen();
        break;
    }

    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => homeScreen),
    );
  }

  Future<void> _handleLogin() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final data = await _authService.login(
        _usernameController.text.trim(),
        _passwordController.text,
      );

      if (mounted) {
        final role = data['user']['role'] as String;
        _navigateToHome(role);
      }
    } on DioException catch (e) {
      setState(() {
        if (e.response?.statusCode == 401) {
          _errorMessage = AppStrings.invalidCredentials;
        } else if (e.type == DioExceptionType.connectionTimeout ||
            e.type == DioExceptionType.connectionError) {
          _errorMessage = 'لا يمكن الاتصال بالخادم';
        } else {
          _errorMessage = AppStrings.loginFailed;
        }
      });
    } catch (_) {
      setState(() {
        _errorMessage = AppStrings.loginFailed;
      });
    } finally {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.rtl,
      child: Scaffold(
        body: Container(
          width: double.infinity,
          height: double.infinity,
          decoration: const BoxDecoration(
            gradient: TaqwaColors.darkGradient,
          ),
          child: SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 28),
              child: FadeTransition(
                opacity: _fadeAnim,
                child: SlideTransition(
                  position: _slideAnim,
                  child: Column(
                    children: [
                      const SizedBox(height: 60),

                      // Logo
                      Container(
                        width: 100,
                        height: 100,
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.1),
                          shape: BoxShape.circle,
                          border: Border.all(
                            color:
                                TaqwaColors.minaretGold.withValues(alpha: 0.5),
                            width: 2,
                          ),
                        ),
                        child: const Icon(
                          Icons.mosque_rounded,
                          size: 50,
                          color: TaqwaColors.minaretGold,
                        ),
                      ),

                      const SizedBox(height: 24),

                      const Text(
                        AppStrings.appName,
                        style: TextStyle(
                          fontSize: 40,
                          fontWeight: FontWeight.w800,
                          color: Colors.white,
                          letterSpacing: 2,
                        ),
                      ),

                      const SizedBox(height: 6),

                      Text(
                        AppStrings.mosqueFullName,
                        style: TextStyle(
                          fontSize: 16,
                          color:
                              TaqwaColors.minaretGold.withValues(alpha: 0.9),
                          fontWeight: FontWeight.w500,
                        ),
                      ),

                      const SizedBox(height: 50),

                      // Login card
                      Container(
                        padding: const EdgeInsets.all(28),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(24),
                          boxShadow: [
                            BoxShadow(
                              color: Colors.black.withValues(alpha: 0.15),
                              blurRadius: 30,
                              offset: const Offset(0, 10),
                            ),
                          ],
                        ),
                        child: Form(
                          key: _formKey,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text(
                                AppStrings.welcomeBack,
                                style: TextStyle(
                                  fontSize: 24,
                                  fontWeight: FontWeight.w700,
                                  color: TaqwaColors.nightSky,
                                ),
                              ),

                              const SizedBox(height: 4),

                              const Text(
                                AppStrings.loginSubtitle,
                                style: TextStyle(
                                  fontSize: 14,
                                  color: TaqwaColors.gray,
                                ),
                              ),

                              const SizedBox(height: 28),

                              // Error message
                              if (_errorMessage != null) ...[
                                Container(
                                  width: double.infinity,
                                  padding: const EdgeInsets.all(14),
                                  decoration: BoxDecoration(
                                    color: TaqwaColors.lightRed,
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(
                                      color: TaqwaColors.alertRed
                                          .withValues(alpha: 0.3),
                                    ),
                                  ),
                                  child: Row(
                                    children: [
                                      const Icon(
                                        Icons.error_outline_rounded,
                                        color: TaqwaColors.alertRed,
                                        size: 20,
                                      ),
                                      const SizedBox(width: 10),
                                      Expanded(
                                        child: Text(
                                          _errorMessage!,
                                          style: const TextStyle(
                                            color: TaqwaColors.alertRed,
                                            fontSize: 13,
                                            fontWeight: FontWeight.w500,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 16),
                              ],

                              // Username
                              TextFormField(
                                controller: _usernameController,
                                textDirection: TextDirection.ltr,
                                textAlign: TextAlign.right,
                                enabled: !_isLoading,
                                decoration: InputDecoration(
                                  hintText: AppStrings.username,
                                  prefixIcon: const Icon(
                                    Icons.person_outline_rounded,
                                    color: TaqwaColors.gray,
                                  ),
                                ),
                                validator: (value) {
                                  if (value == null || value.isEmpty) {
                                    return AppStrings.usernameRequired;
                                  }
                                  return null;
                                },
                              ),

                              const SizedBox(height: 16),

                              // Password
                              TextFormField(
                                controller: _passwordController,
                                obscureText: !_isPasswordVisible,
                                textDirection: TextDirection.ltr,
                                textAlign: TextAlign.right,
                                enabled: !_isLoading,
                                decoration: InputDecoration(
                                  hintText: AppStrings.password,
                                  prefixIcon: const Icon(
                                    Icons.lock_outline_rounded,
                                    color: TaqwaColors.gray,
                                  ),
                                  suffixIcon: IconButton(
                                    icon: Icon(
                                      _isPasswordVisible
                                          ? Icons.visibility_off_rounded
                                          : Icons.visibility_rounded,
                                      color: TaqwaColors.gray,
                                    ),
                                    onPressed: () {
                                      setState(() {
                                        _isPasswordVisible =
                                            !_isPasswordVisible;
                                      });
                                    },
                                  ),
                                ),
                                validator: (value) {
                                  if (value == null || value.isEmpty) {
                                    return AppStrings.passwordRequired;
                                  }
                                  return null;
                                },
                                onFieldSubmitted: (_) => _handleLogin(),
                              ),

                              const SizedBox(height: 28),

                              // Login button
                              SizedBox(
                                width: double.infinity,
                                height: 54,
                                child: ElevatedButton(
                                  onPressed:
                                      _isLoading ? null : _handleLogin,
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: TaqwaColors.domeBlue,
                                    foregroundColor: Colors.white,
                                    shape: RoundedRectangleBorder(
                                      borderRadius:
                                          BorderRadius.circular(14),
                                    ),
                                    elevation: 4,
                                    shadowColor: TaqwaColors.domeBlue
                                        .withValues(alpha: 0.4),
                                  ),
                                  child: _isLoading
                                      ? const SizedBox(
                                          width: 24,
                                          height: 24,
                                          child:
                                              CircularProgressIndicator(
                                            color: Colors.white,
                                            strokeWidth: 2.5,
                                          ),
                                        )
                                      : const Text(
                                          AppStrings.login,
                                          style: TextStyle(
                                            fontSize: 17,
                                            fontWeight: FontWeight.w700,
                                          ),
                                        ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),

                      const SizedBox(height: 40),

                      Text(
                        AppStrings.mosqueFullName,
                        style: TextStyle(
                          fontSize: 12,
                          color: Colors.white.withValues(alpha: 0.4),
                        ),
                      ),

                      const SizedBox(height: 30),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}