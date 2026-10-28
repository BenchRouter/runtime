"""The BenchRouter Databricks App: the installer and consent screen (plan section 4.1).

It does only what needs the signed-in admin: the BenchRouter sign-in, the OBO SQL grants, the
first objects of Connect, and the requests behind New route, Expose, Add eval and Disconnect.
The agent job does the rest as the app SP. The app never runs evals.
"""
