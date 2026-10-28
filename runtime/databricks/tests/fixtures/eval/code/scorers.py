from mlflow.genai.scorers import scorer
TONE = {"q1": "good", "q2": "good", "q3": "maybe"}
RATING = {"q1": 7, "q2": 3, "q3": 12}
@scorer
def exact(outputs, expectations):
    return outputs == expectations["answer"]
@scorer
def always(outputs):
    return True
@scorer
def tone(inputs):
    return TONE[inputs["question"]]
@scorer
def rating(inputs):
    return RATING[inputs["question"]]
@scorer
def broken(outputs):
    raise RuntimeError("judge unavailable")
SCORERS = [exact, always, tone, rating, broken]
